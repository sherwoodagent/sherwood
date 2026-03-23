/**
 * EAS (Ethereum Attestation Service) wrapper for syndicate join requests and approvals.
 *
 * Uses viem for on-chain writes and the EAS GraphQL API for queries.
 * No ethers dependency — attestation data is encoded with viem's encodeAbiParameters.
 */

import type { Address, Hex } from "viem";
import { encodeAbiParameters, parseAbiParameters, decodeAbiParameters } from "viem";
import { getPublicClient, getWalletClient, getAccount } from "./client.js";
import { getChain, getNetwork, getChainConfig } from "./network.js";
import { EAS_CONTRACTS, EAS_SCHEMAS } from "./addresses.js";
import { EAS_ABI } from "./abis.js";

// ── Schema definitions ──

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

// keccak256("Attested(address,address,bytes32,bytes32)")
const ATTESTED_TOPIC = "0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35" as Hex;

const JOIN_REQUEST_PARAMS = parseAbiParameters("uint256, uint256, address, string");
const AGENT_APPROVED_PARAMS = parseAbiParameters("uint256, uint256, address");
const X402_RESEARCH_PARAMS = parseAbiParameters("string, string, string, string, string");
const VENICE_PROVISION_PARAMS = parseAbiParameters("address, string");
const VENICE_INFERENCE_PARAMS = parseAbiParameters("string, uint256, uint256, string");
const TRADE_EXECUTED_PARAMS = parseAbiParameters("address, address, uint256, string, string, string");

function assertSchemasRegistered() {
  const schemas = EAS_SCHEMAS();
  if (schemas.SYNDICATE_JOIN_REQUEST === ZERO_BYTES32 || schemas.AGENT_APPROVED === ZERO_BYTES32) {
    throw new Error(
      "EAS schemas not registered. Run: npx tsx scripts/register-eas-schemas.ts --testnet",
    );
  }
}

// ── GraphQL ──

function getEasGraphqlUrl(): string {
  const url = getChainConfig().easGraphqlUrl;
  if (!url) {
    throw new Error(
      `EAS is not available on ${getNetwork()}. Attestation operations require a chain with EAS (e.g. base, base-sepolia).`,
    );
  }
  return url;
}

export function getEasScanUrl(uid: Hex): string {
  const host = getChainConfig().easScanHost;
  if (!host) {
    throw new Error(`EAS scan is not available on ${getNetwork()}.`);
  }
  return `https://${host}/attestation/view/${uid}`;
}

// ── Attestation Creation ──

/**
 * Extract the attestation UID from a transaction receipt.
 * The EAS contract emits: event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)
 * uid is a non-indexed parameter in the event data.
 */
function extractAttestationUid(receipt: { logs: readonly { topics: readonly Hex[]; data: Hex }[] }): Hex {
  for (const log of receipt.logs) {
    // Match the Attested event signature to avoid false positives from other events
    if (log.topics[0] !== ATTESTED_TOPIC) continue;
    // Attested event has 4 topics (sig + 3 indexed) and data contains the uid (bytes32)
    if (log.topics.length === 4 && log.data.length >= 66) {
      return ("0x" + log.data.slice(2, 66)) as Hex;
    }
  }
  throw new Error("Could not extract attestation UID from transaction receipt");
}

/**
 * Create a SYNDICATE_JOIN_REQUEST attestation.
 * Attester: the calling agent. Recipient: the syndicate creator.
 */
export async function createJoinRequest(
  syndicateId: bigint,
  agentId: bigint,
  vault: Address,
  creatorAddress: Address,
  message: string,
): Promise<{ uid: Hex; hash: Hex }> {
  assertSchemasRegistered();
  const wallet = getWalletClient();
  const client = getPublicClient();

  const data = encodeAbiParameters(JOIN_REQUEST_PARAMS, [
    syndicateId, agentId, vault, message,
  ]);

  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: EAS_CONTRACTS().EAS,
    abi: EAS_ABI,
    functionName: "attest",
    args: [{
      schema: EAS_SCHEMAS().SYNDICATE_JOIN_REQUEST,
      data: {
        recipient: creatorAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: ZERO_BYTES32,
        data,
        value: 0n,
      },
    }],
    value: 0n,
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  const uid = extractAttestationUid(receipt);

  return { uid, hash };
}

/**
 * Create an AGENT_APPROVED attestation.
 * Attester: the syndicate creator. Recipient: the agent wallet.
 */
export async function createApproval(
  syndicateId: bigint,
  agentId: bigint,
  vault: Address,
  agentAddress: Address,
): Promise<{ uid: Hex; hash: Hex }> {
  assertSchemasRegistered();
  const wallet = getWalletClient();
  const client = getPublicClient();

  const data = encodeAbiParameters(AGENT_APPROVED_PARAMS, [
    syndicateId, agentId, vault,
  ]);

  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: EAS_CONTRACTS().EAS,
    abi: EAS_ABI,
    functionName: "attest",
    args: [{
      schema: EAS_SCHEMAS().AGENT_APPROVED,
      data: {
        recipient: agentAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: ZERO_BYTES32,
        data,
        value: 0n,
      },
    }],
    value: 0n,
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  const uid = extractAttestationUid(receipt);

  return { uid, hash };
}

/**
 * Revoke an attestation. Only the original attester can revoke.
 */
export async function revokeAttestation(
  schemaUid: Hex,
  attestationUid: Hex,
): Promise<Hex> {
  const wallet = getWalletClient();

  return wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: EAS_CONTRACTS().EAS,
    abi: EAS_ABI,
    functionName: "revoke",
    args: [{
      schema: schemaUid,
      data: {
        uid: attestationUid,
        value: 0n,
      },
    }],
    value: 0n,
  });
}

/**
 * Create an X402_RESEARCH attestation — records a research query on-chain.
 * Attester: the agent. Recipient: the agent itself (self-attestation for audit trail).
 * Schema: "string provider, string queryType, string prompt, string costUsdc, string resultUri"
 */
export async function createResearchAttestation(
  provider: string,
  queryType: string,
  prompt: string,
  costUsdc: string,
  resultUri: string,
): Promise<{ uid: Hex; hash: Hex }> {
  const schemas = EAS_SCHEMAS();
  if (schemas.X402_RESEARCH === ZERO_BYTES32) {
    throw new Error(
      "X402_RESEARCH schema not registered. Run: npx tsx scripts/register-eas-schemas.ts --testnet",
    );
  }

  const wallet = getWalletClient();
  const client = getPublicClient();
  const account = getAccount();

  const data = encodeAbiParameters(X402_RESEARCH_PARAMS, [
    provider, queryType, prompt, costUsdc, resultUri,
  ]);

  const hash = await wallet.writeContract({
    account,
    chain: getChain(),
    address: EAS_CONTRACTS().EAS,
    abi: EAS_ABI,
    functionName: "attest",
    args: [{
      schema: schemas.X402_RESEARCH,
      data: {
        recipient: account.address,
        expirationTime: 0n,
        revocable: false,
        refUID: ZERO_BYTES32,
        data,
        value: 0n,
      },
    }],
    value: 0n,
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  const uid = extractAttestationUid(receipt);

  return { uid, hash };
}

/**
 * Create a VENICE_PROVISION attestation — records that an agent provisioned a Venice API key.
 * Schema: "address agent, string status"
 */
export async function createVeniceProvisionAttestation(
  agent: Address,
): Promise<{ uid: Hex; hash: Hex }> {
  const schemas = EAS_SCHEMAS();
  if (schemas.VENICE_PROVISION === ZERO_BYTES32) return skipAttestation("VENICE_PROVISION");

  const wallet = getWalletClient();
  const client = getPublicClient();
  const account = getAccount();

  const data = encodeAbiParameters(VENICE_PROVISION_PARAMS, [agent, "provisioned"]);

  const hash = await wallet.writeContract({
    account,
    chain: getChain(),
    address: EAS_CONTRACTS().EAS,
    abi: EAS_ABI,
    functionName: "attest",
    args: [{
      schema: schemas.VENICE_PROVISION,
      data: {
        recipient: agent,
        expirationTime: 0n,
        revocable: false,
        refUID: ZERO_BYTES32,
        data,
        value: 0n,
      },
    }],
    value: 0n,
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  const uid = extractAttestationUid(receipt);
  return { uid, hash };
}

/**
 * Create a VENICE_INFERENCE attestation — records an inference call.
 * Schema: "string model, uint256 promptTokens, uint256 completionTokens, string promptHash"
 */
export async function createVeniceInferenceAttestation(
  model: string,
  promptTokens: number,
  completionTokens: number,
  promptHash: string,
): Promise<{ uid: Hex; hash: Hex }> {
  const schemas = EAS_SCHEMAS();
  if (schemas.VENICE_INFERENCE === ZERO_BYTES32) return skipAttestation("VENICE_INFERENCE");

  const wallet = getWalletClient();
  const client = getPublicClient();
  const account = getAccount();

  const data = encodeAbiParameters(VENICE_INFERENCE_PARAMS, [
    model,
    BigInt(promptTokens),
    BigInt(completionTokens),
    promptHash,
  ]);

  const hash = await wallet.writeContract({
    account,
    chain: getChain(),
    address: EAS_CONTRACTS().EAS,
    abi: EAS_ABI,
    functionName: "attest",
    args: [{
      schema: schemas.VENICE_INFERENCE,
      data: {
        recipient: account.address,
        expirationTime: 0n,
        revocable: false,
        refUID: ZERO_BYTES32,
        data,
        value: 0n,
      },
    }],
    value: 0n,
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  const uid = extractAttestationUid(receipt);
  return { uid, hash };
}

/**
 * Create a TRADE_EXECUTED attestation — records a swap on-chain.
 * Schema: "address tokenIn, address tokenOut, uint256 amountIn, string amountOut, string txHash, string routing"
 */
export async function createTradeAttestation(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  amountOut: string,
  txHash: string,
  routing: string,
): Promise<{ uid: Hex; hash: Hex }> {
  const schemas = EAS_SCHEMAS();
  if (schemas.TRADE_EXECUTED === ZERO_BYTES32) return skipAttestation("TRADE_EXECUTED");

  const wallet = getWalletClient();
  const client = getPublicClient();
  const account = getAccount();

  const data = encodeAbiParameters(TRADE_EXECUTED_PARAMS, [
    tokenIn, tokenOut, amountIn, amountOut, txHash, routing,
  ]);

  const hash = await wallet.writeContract({
    account,
    chain: getChain(),
    address: EAS_CONTRACTS().EAS,
    abi: EAS_ABI,
    functionName: "attest",
    args: [{
      schema: schemas.TRADE_EXECUTED,
      data: {
        recipient: account.address,
        expirationTime: 0n,
        revocable: false,
        refUID: ZERO_BYTES32,
        data,
        value: 0n,
      },
    }],
    value: 0n,
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  const uid = extractAttestationUid(receipt);
  return { uid, hash };
}

/** Skip attestation gracefully when schema isn't registered on this chain. */
function skipAttestation(name: string): { uid: Hex; hash: Hex } {
  return { uid: ZERO_BYTES32, hash: ZERO_BYTES32 };
}

// ── Attestation Queries ──

export interface JoinRequestAttestation {
  uid: Hex;
  attester: Address;
  recipient: Address;
  time: number;
  decoded: {
    syndicateId: bigint;
    agentId: bigint;
    vault: Address;
    message: string;
  };
}

/**
 * Query pending (non-revoked) join requests for a given recipient (creator address).
 * Uses the EAS GraphQL API.
 */
export interface ApprovalAttestation {
  uid: Hex;
  attester: Address;
  recipient: Address;
  time: number;
  decoded: {
    syndicateId: bigint;
    agentId: bigint;
    vault: Address;
  };
}

/**
 * Query existing (non-revoked) AGENT_APPROVED attestations created by a given attester (creator).
 * Used to check for duplicates before creating a new approval and to filter already-approved agents from requests.
 */
export async function queryApprovals(
  attester: Address,
): Promise<ApprovalAttestation[]> {
  assertSchemasRegistered();
  const schemaUid = EAS_SCHEMAS().AGENT_APPROVED;
  const url = getEasGraphqlUrl();

  const query = `
    query Approvals($schemaId: String!, $attester: String!) {
      attestations(
        where: {
          schemaId: { equals: $schemaId }
          attester: { equals: $attester }
          revoked: { equals: false }
        }
        orderBy: [{ time: desc }]
      ) {
        id
        attester
        recipient
        time
        data
      }
    }
  `;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { schemaId: schemaUid, attester },
    }),
  });

  if (!response.ok) {
    throw new Error(`EAS GraphQL query failed: ${response.statusText}`);
  }

  const json = await response.json() as {
    data?: {
      attestations: Array<{
        id: string;
        attester: string;
        recipient: string;
        time: number;
        data: string;
      }>;
    };
  };

  if (!json.data?.attestations) return [];

  return json.data.attestations.map((a) => {
    const decoded = decodeAbiParameters(AGENT_APPROVED_PARAMS, a.data as Hex);
    return {
      uid: a.id as Hex,
      attester: a.attester as Address,
      recipient: a.recipient as Address,
      time: a.time,
      decoded: {
        syndicateId: decoded[0],
        agentId: decoded[1],
        vault: decoded[2],
      },
    };
  });
}

export async function queryJoinRequests(
  recipient: Address,
): Promise<JoinRequestAttestation[]> {
  assertSchemasRegistered();
  const schemaUid = EAS_SCHEMAS().SYNDICATE_JOIN_REQUEST;
  const url = getEasGraphqlUrl();

  const query = `
    query JoinRequests($schemaId: String!, $recipient: String!) {
      attestations(
        where: {
          schemaId: { equals: $schemaId }
          recipient: { equals: $recipient }
          revoked: { equals: false }
        }
        orderBy: [{ time: desc }]
      ) {
        id
        attester
        recipient
        time
        data
      }
    }
  `;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { schemaId: schemaUid, recipient },
    }),
  });

  if (!response.ok) {
    throw new Error(`EAS GraphQL query failed: ${response.statusText}`);
  }

  const json = await response.json() as {
    data?: {
      attestations: Array<{
        id: string;
        attester: string;
        recipient: string;
        time: number;
        data: string;
      }>;
    };
  };

  if (!json.data?.attestations) return [];

  return json.data.attestations.map((a) => {
    const decoded = decodeAbiParameters(JOIN_REQUEST_PARAMS, a.data as Hex);
    return {
      uid: a.id as Hex,
      attester: a.attester as Address,
      recipient: a.recipient as Address,
      time: a.time,
      decoded: {
        syndicateId: decoded[0],
        agentId: decoded[1],
        vault: decoded[2],
        message: decoded[3],
      },
    };
  });
}
