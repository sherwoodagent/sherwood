/**
 * EAS (Ethereum Attestation Service) wrapper for syndicate join requests and approvals.
 *
 * Uses viem for on-chain writes and the EAS GraphQL API for queries.
 * No ethers dependency — attestation data is encoded with viem's encodeAbiParameters.
 */

import type { Address, Hex } from "viem";
import { encodeAbiParameters, parseAbiParameters, decodeAbiParameters } from "viem";
import { getPublicClient, getWalletClient, getAccount } from "./client.js";
import { getChain, getNetwork } from "./network.js";
import { EAS_CONTRACTS, EAS_SCHEMAS } from "./addresses.js";
import { EAS_ABI } from "./abis.js";

// ── Schema definitions ──

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

const JOIN_REQUEST_PARAMS = parseAbiParameters("uint256, uint256, address, string");
const AGENT_APPROVED_PARAMS = parseAbiParameters("uint256, uint256, address");

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
  return getNetwork() === "base"
    ? "https://base.easscan.org/graphql"
    : "https://base-sepolia.easscan.org/graphql";
}

export function getEasScanUrl(uid: Hex): string {
  const host = getNetwork() === "base" ? "base.easscan.org" : "base-sepolia.easscan.org";
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
 * Attester: the syndicate creator. Recipient: the agent's operator EOA.
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
