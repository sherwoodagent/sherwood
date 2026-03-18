/**
 * EAS (Ethereum Attestation Service) GraphQL queries.
 *
 * Fetches SYNDICATE_JOIN_REQUEST and AGENT_APPROVED attestations
 * for a given syndicate, decoded and sorted chronologically.
 */

import { decodeAbiParameters, type Address } from "viem";
import { getAddresses } from "./contracts";

// ── Types ──────────────────────────────────────────────────

export interface AttestationItem {
  uid: string;
  type: "JOIN_REQUEST" | "APPROVED";
  attester: Address;
  recipient: Address;
  time: number; // unix seconds
  txid: string;
  revoked: boolean;
  // Decoded data
  syndicateId: bigint;
  agentId: bigint;
  vault: Address;
  message?: string; // only for JOIN_REQUEST
}

// ── GraphQL ────────────────────────────────────────────────

interface RawAttestation {
  id: string;
  attester: string;
  recipient: string;
  time: number;
  data: string;
  txid: string;
  revoked: boolean;
}

function getEasGraphqlUrl(): string {
  const addresses = getAddresses();
  return `${addresses.easExplorer}/graphql`;
}

export async function fetchSyndicateAttestations(
  creator: Address,
  syndicateId: bigint,
): Promise<AttestationItem[]> {
  const addresses = getAddresses();
  const url = getEasGraphqlUrl();

  const query = `
    query SyndicateAttestations($joinSchema: String!, $approveSchema: String!, $creator: String!) {
      joinRequests: attestations(
        where: {
          schemaId: { equals: $joinSchema }
          recipient: { equals: $creator }
        }
        orderBy: [{ time: desc }]
        take: 50
      ) {
        id
        attester
        recipient
        time
        data
        txid
        revoked
      }
      approvals: attestations(
        where: {
          schemaId: { equals: $approveSchema }
          attester: { equals: $creator }
        }
        orderBy: [{ time: desc }]
        take: 50
      ) {
        id
        attester
        recipient
        time
        data
        txid
        revoked
      }
    }
  `;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: {
          joinSchema: addresses.easSchemas.joinRequest,
          approveSchema: addresses.easSchemas.agentApproved,
          creator: creator, // EAS GraphQL is case-sensitive — use checksummed address
        },
      }),
      next: { revalidate: 60 },
    });

    if (!response.ok) return [];

    const result = await response.json();
    const joinRequests: RawAttestation[] =
      result?.data?.joinRequests || [];
    const approvals: RawAttestation[] =
      result?.data?.approvals || [];

    const items: AttestationItem[] = [];

    // Decode join requests
    for (const raw of joinRequests) {
      const decoded = decodeJoinRequest(raw.data);
      if (!decoded || decoded.syndicateId !== syndicateId) continue;

      items.push({
        uid: raw.id,
        type: "JOIN_REQUEST",
        attester: raw.attester as Address,
        recipient: raw.recipient as Address,
        time: raw.time,
        txid: raw.txid,
        revoked: raw.revoked,
        syndicateId: decoded.syndicateId,
        agentId: decoded.agentId,
        vault: decoded.vault,
        message: decoded.message,
      });
    }

    // Decode approvals
    for (const raw of approvals) {
      const decoded = decodeApproval(raw.data);
      if (!decoded || decoded.syndicateId !== syndicateId) continue;

      items.push({
        uid: raw.id,
        type: "APPROVED",
        attester: raw.attester as Address,
        recipient: raw.recipient as Address,
        time: raw.time,
        txid: raw.txid,
        revoked: raw.revoked,
        syndicateId: decoded.syndicateId,
        agentId: decoded.agentId,
        vault: decoded.vault,
      });
    }

    // Sort chronologically (newest first)
    items.sort((a, b) => b.time - a.time);

    return items;
  } catch {
    return [];
  }
}

// ── ABI decode helpers ─────────────────────────────────────

function decodeJoinRequest(
  data: string,
): {
  syndicateId: bigint;
  agentId: bigint;
  vault: Address;
  message: string;
} | null {
  try {
    const [syndicateId, agentId, vault, message] = decodeAbiParameters(
      [
        { name: "syndicateId", type: "uint256" },
        { name: "agentId", type: "uint256" },
        { name: "vault", type: "address" },
        { name: "message", type: "string" },
      ],
      data as `0x${string}`,
    );
    return { syndicateId, agentId, vault, message };
  } catch {
    return null;
  }
}

function decodeApproval(
  data: string,
): {
  syndicateId: bigint;
  agentId: bigint;
  vault: Address;
} | null {
  try {
    const [syndicateId, agentId, vault] = decodeAbiParameters(
      [
        { name: "syndicateId", type: "uint256" },
        { name: "agentId", type: "uint256" },
        { name: "vault", type: "address" },
      ],
      data as `0x${string}`,
    );
    return { syndicateId, agentId, vault };
  } catch {
    return null;
  }
}
