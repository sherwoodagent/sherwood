/**
 * One-time script to register EAS schemas for Sherwood syndicate join requests.
 *
 * Usage (run from cli/ directory):
 *   cd cli && npx tsx scripts/register-eas-schemas.ts --testnet
 *
 * After running, paste the output schema UIDs into src/lib/addresses.ts.
 */

import { config as loadDotenv } from "dotenv";
try { loadDotenv(); } catch {}

import { createPublicClient, createWalletClient, http, keccak256, encodePacked } from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import fs from "node:fs";
import path from "node:path";

// ── Parse args ──

const isTestnet = process.argv.includes("--testnet");
const chain = isTestnet ? baseSepolia : base;
const rpcUrl = isTestnet
  ? (process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org")
  : (process.env.BASE_RPC_URL || "https://mainnet.base.org");

// ── Resolve private key ──

function getPrivateKey(): `0x${string}` {
  const env = process.env.PRIVATE_KEY;
  if (env) return (env.startsWith("0x") ? env : `0x${env}`) as `0x${string}`;

  const configPath = path.join(process.env.HOME || "~", ".sherwood", "config.json");
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (config.privateKey) {
      const k = config.privateKey;
      return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
    }
  }

  throw new Error("Private key not found. Set PRIVATE_KEY env var or run 'sherwood config set --private-key <key>'.");
}

// ── Contracts ──

const SCHEMA_REGISTRY = "0x4200000000000000000000000000000000000020" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const SCHEMA_REGISTRY_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "schema", type: "string" },
      { name: "resolver", type: "address" },
      { name: "revocable", type: "bool" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

/**
 * Compute the expected schema UID deterministically.
 * UID = keccak256(abi.encodePacked(schema, resolver, revocable))
 */
function computeSchemaUid(schema: string, resolver: string, revocable: boolean): Hex {
  return keccak256(
    encodePacked(
      ["string", "address", "bool"],
      [schema, resolver as `0x${string}`, revocable],
    ),
  );
}

/**
 * Extract the schema UID from a registration receipt.
 * The Registered event has: uid (indexed bytes32) in topics[1].
 */
function extractSchemaUid(receipt: { logs: readonly { topics: readonly Hex[] }[] }): Hex | null {
  for (const log of receipt.logs) {
    // Registered event has 3+ topics: [eventSig, uid (indexed), registerer (indexed)]
    if (log.topics.length >= 3) {
      return log.topics[1];
    }
  }
  return null;
}

// ── Schemas ──

const SCHEMAS = [
  {
    name: "SYNDICATE_JOIN_REQUEST",
    definition: "uint256 syndicateId, uint256 agentId, address vault, string message",
    revocable: true,
  },
  {
    name: "AGENT_APPROVED",
    definition: "uint256 syndicateId, uint256 agentId, address vault",
    revocable: true,
  },
  {
    name: "X402_RESEARCH",
    definition: "string provider, string queryType, string prompt, string costUsdc, string resultUri",
    revocable: false,
  },
  {
    name: "VENICE_PROVISION",
    definition: "address agent, string status",
    revocable: false,
  },
  {
    name: "VENICE_INFERENCE",
    definition: "string model, uint256 promptTokens, uint256 completionTokens, string promptHash",
    revocable: false,
  },
  {
    name: "TRADE_EXECUTED",
    definition: "address tokenIn, address tokenOut, uint256 amountIn, string amountOut, string txHash, string routing",
    revocable: false,
  },
];

// ── Main ──

async function main() {
  const account = privateKeyToAccount(getPrivateKey());
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  console.log(`\nNetwork: ${chain.name}`);
  console.log(`Account: ${account.address}`);
  console.log(`Schema Registry: ${SCHEMA_REGISTRY}\n`);

  const results: { name: string; uid: Hex }[] = [];

  for (const schema of SCHEMAS) {
    const expectedUid = computeSchemaUid(schema.definition, ZERO_ADDRESS, schema.revocable);
    console.log(`Registering ${schema.name}...`);
    console.log(`  Expected UID: ${expectedUid}`);

    try {
      const hash = await walletClient.writeContract({
        address: SCHEMA_REGISTRY,
        abi: SCHEMA_REGISTRY_ABI,
        functionName: "register",
        args: [schema.definition, ZERO_ADDRESS, schema.revocable],
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const uid = extractSchemaUid(receipt) || expectedUid;

      console.log(`  TX: ${hash}`);
      console.log(`  UID: ${uid}\n`);
      results.push({ name: schema.name, uid });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("AlreadyExists") || msg.includes("already")) {
        console.log(`  Already registered — using computed UID: ${expectedUid}\n`);
        results.push({ name: schema.name, uid: expectedUid });
      } else {
        // Schema might already be registered. Use computed UID as fallback.
        console.log(`  Registration failed: ${msg}`);
        console.log(`  Using computed UID: ${expectedUid}\n`);
        results.push({ name: schema.name, uid: expectedUid });
      }
    }
  }

  // ── Output for addresses.ts ──
  const networkLabel = isTestnet ? "BASE_SEPOLIA_EAS_SCHEMAS" : "BASE_EAS_SCHEMAS";
  console.log("─".repeat(60));
  console.log(`\nPaste into src/lib/addresses.ts (${networkLabel}):\n`);
  console.log(`const ${networkLabel} = {`);
  for (const r of results) {
    console.log(`  ${r.name}: "${r.uid}" as \`0x\${string}\`,`);
  }
  console.log(`} as const;\n`);

  const scanHost = isTestnet ? "base-sepolia.easscan.org" : "base.easscan.org";
  console.log(`View on EAS Scan:`);
  for (const r of results) {
    console.log(`  https://${scanHost}/schema/view/${r.uid}`);
  }
  console.log();
}

main().catch((err) => {
  console.error("\nFailed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
