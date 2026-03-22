import { describe, it, expect } from "vitest";
import { encodeEventTopics, encodeAbiParameters, type Log } from "viem";
import { SYNDICATE_GOVERNOR_ABI } from "./abis.js";
import { parseProposalIdFromLogs } from "./governor.js";

/**
 * Build a synthetic ProposalCreated log matching the governor ABI.
 * Indexed params go into topics, non-indexed into data.
 */
function buildProposalCreatedLog(proposalId: bigint): Log {
  const vault = "0x000000000000000000000000000000000000dead";
  const proposer = "0x000000000000000000000000000000000000beef";

  const topics = encodeEventTopics({
    abi: SYNDICATE_GOVERNOR_ABI,
    eventName: "ProposalCreated",
    args: {
      proposalId,
      proposer,
      vault,
    },
  });

  // Non-indexed params: performanceFeeBps, strategyDuration,
  // executeCallCount, settlementCallCount, metadataURI
  const data = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "string" },
    ],
    [1500n, 604800n, 1n, 1n, "ipfs://test"],
  );

  return {
    address: "0x0000000000000000000000000000000000000001",
    topics: topics as [
      `0x${string}`,
      ...`0x${string}`[],
    ],
    data,
    blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    blockNumber: 1n,
    transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

describe("parseProposalIdFromLogs", () => {
  it("extracts proposalId from a valid ProposalCreated log", () => {
    const log = buildProposalCreatedLog(1n);
    expect(parseProposalIdFromLogs([log])).toBe(1n);
  });

  it("extracts proposalId for subsequent proposals", () => {
    const log = buildProposalCreatedLog(5n);
    expect(parseProposalIdFromLogs([log])).toBe(5n);
  });

  it("returns undefined for empty logs", () => {
    expect(parseProposalIdFromLogs([])).toBeUndefined();
  });

  it("returns undefined for unrelated logs", () => {
    const unrelatedLog: Log = {
      address: "0x0000000000000000000000000000000000000001",
      topics: ["0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
      data: "0x",
      blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      blockNumber: 1n,
      transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    };
    expect(parseProposalIdFromLogs([unrelatedLog])).toBeUndefined();
  });

  it("picks the first ProposalCreated when multiple exist", () => {
    const log1 = buildProposalCreatedLog(3n);
    const log2 = buildProposalCreatedLog(4n);
    expect(parseProposalIdFromLogs([log1, log2])).toBe(3n);
  });

  it("never returns 0 for a real proposal — contract is 1-indexed", () => {
    // Proposal ID 0 would mean parsing failed or no event was found.
    // A log with proposalId=1 must return 1, not 0.
    const log = buildProposalCreatedLog(1n);
    const result = parseProposalIdFromLogs([log]);
    expect(result).not.toBe(0n);
    expect(result).toBe(1n);
  });
});
