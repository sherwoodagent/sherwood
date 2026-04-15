import { NextRequest, NextResponse } from "next/server";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { getPublicClient, SYNDICATE_VAULT_ABI } from "@/lib/contracts";
import { makeRateLimit } from "@/lib/rate-limit";

// Tighter limit than /api/prices because each Tenderly call costs real money.
const checkRateLimit = makeRateLimit({ windowMs: 60_000, max: 20 });

// ── ABI fragment for encoding ────────────────────────────

const EXECUTE_GOVERNOR_BATCH_ABI = [
  {
    name: "executeGovernorBatch",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

// ── Types ────────────────────────────────────────────────

interface SimulateRequestBody {
  vault: string;
  chainId: number;
  calls: Array<{ target: string; data: string; value: string }>;
}

interface TenderlyCallTrace {
  hash?: string;
  from: string;
  to: string;
  input: string;
  output: string;
  gas_used: number;
  error?: string;
  calls?: TenderlyCallTrace[];
}

interface TenderlySimResponse {
  transaction: {
    status: boolean;
    gas_used: number;
    call_trace: TenderlyCallTrace;
    error_message?: string;
  };
}

interface CallResult {
  index: number;
  target: string;
  success: boolean;
  gasUsed: number;
  returnData: string;
}

// ── Helpers ──────────────────────────────────────────────

const SUPPORTED_CHAINS = new Set([8453, 84532]);

/**
 * Walk the Tenderly call trace tree to find the leaf calls
 * from the BatchExecutorLib.executeBatch delegatecall.
 *
 * The trace structure is:
 *   vault.executeGovernorBatch (top)
 *     └─ delegatecall to BatchExecutorLib.executeBatch
 *         ├─ call to target[0]
 *         ├─ call to target[1]
 *         └─ ...
 *
 * We find the delegatecall node and extract its children.
 */
function extractBatchCalls(trace: TenderlyCallTrace): CallResult[] {
  const results: CallResult[] = [];

  // Look for the delegatecall to executeBatch — its children are the batch calls
  function walk(node: TenderlyCallTrace, depth: number): boolean {
    if (!node.calls) return false;

    // The delegatecall to BatchExecutorLib is typically at depth 1
    // Its children are the actual batch calls
    for (const child of node.calls) {
      // If this child has children that look like batch calls (depth 2+),
      // continue walking
      if (child.calls && child.calls.length > 0 && depth < 2) {
        if (walk(child, depth + 1)) return true;
      }
    }

    // If we're at the right level and have multiple children, these are the batch calls
    if (depth >= 1 && node.calls.length > 0) {
      for (let i = 0; i < node.calls.length; i++) {
        const call = node.calls[i];
        results.push({
          index: i,
          target: call.to,
          success: !call.error,
          gasUsed: call.gas_used || 0,
          returnData: call.output || "0x",
        });
      }
      return true;
    }

    return false;
  }

  walk(trace, 0);

  // If walking didn't find structured batch calls, return a single top-level result
  if (results.length === 0) {
    results.push({
      index: 0,
      target: trace.to,
      success: !trace.error,
      gasUsed: trace.gas_used || 0,
      returnData: trace.output || "0x",
    });
  }

  return results;
}

// ── Route handler ────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!checkRateLimit(req)) {
    return NextResponse.json(
      { error: "Rate limit exceeded — try again in a minute." },
      { status: 429 },
    );
  }

  const accountSlug = process.env.TENDERLY_ACCOUNT_SLUG;
  const projectSlug = process.env.TENDERLY_PROJECT_SLUG;
  const accessKey = process.env.TENDERLY_ACCESS_KEY;

  if (!accountSlug || !projectSlug || !accessKey) {
    return NextResponse.json(
      { error: "Simulation is not configured" },
      { status: 503 },
    );
  }

  // Parse and validate request body
  let body: SimulateRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.vault || typeof body.vault !== "string") {
    return NextResponse.json(
      { error: "Missing or invalid 'vault' field" },
      { status: 400 },
    );
  }

  if (!body.chainId || !SUPPORTED_CHAINS.has(body.chainId)) {
    return NextResponse.json(
      { error: `Unsupported chainId: ${body.chainId}. Supported: ${[...SUPPORTED_CHAINS].join(", ")}` },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.calls) || body.calls.length === 0) {
    return NextResponse.json(
      { error: "Missing or empty 'calls' array" },
      { status: 400 },
    );
  }

  // Resolve governor address from vault onchain
  let governor: Address;
  try {
    const client = getPublicClient(body.chainId);
    governor = (await client.readContract({
      address: body.vault as Address,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "governor",
    })) as Address;
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to read governor from vault: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 },
    );
  }

  // Encode executeGovernorBatch(calls)
  const callsForEncoding = body.calls.map((c) => ({
    target: c.target as Address,
    data: c.data as Hex,
    value: BigInt(c.value || "0"),
  }));

  const input = encodeFunctionData({
    abi: EXECUTE_GOVERNOR_BATCH_ABI,
    functionName: "executeGovernorBatch",
    args: [callsForEncoding],
  });

  // Call Tenderly Simulation API
  const tenderlyUrl = `https://api.tenderly.co/api/v1/account/${accountSlug}/project/${projectSlug}/simulate`;

  const tenderlyResponse = await fetch(tenderlyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Access-Key": accessKey,
    },
    body: JSON.stringify({
      network_id: String(body.chainId),
      from: governor,
      to: body.vault,
      input,
      gas: 30_000_000,
      gas_price: 0,
      value: 0,
      simulation_type: "full",
      save: false,
      save_if_fails: false,
    }),
  });

  if (!tenderlyResponse.ok) {
    const text = await tenderlyResponse.text();
    console.error(`Tenderly simulation failed (${tenderlyResponse.status}): ${text}`);
    return NextResponse.json(
      { error: "Simulation failed", details: text },
      { status: 502 },
    );
  }

  const result = (await tenderlyResponse.json()) as TenderlySimResponse;
  const tx = result.transaction;

  // Extract per-call results from the call trace
  const callResults = extractBatchCalls(tx.call_trace);

  return NextResponse.json({
    success: tx.status,
    totalGasUsed: tx.gas_used,
    errorMessage: tx.error_message || null,
    calls: callResults,
  });
}
