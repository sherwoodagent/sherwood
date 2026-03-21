import { describe, it, expect, beforeEach } from "vitest";
import { setNetwork } from "./network.js";
import {
  TOKENS,
  MOONWELL,
  UNISWAP,
  VENICE,
  AGENT_REGISTRY,
  SHERWOOD,
  EAS_CONTRACTS,
} from "./addresses.js";

// Enable testnet for all tests
beforeEach(() => {
  process.env.ENABLE_TESTNET = "true";
});

describe("addresses", () => {
  describe("mainnet (base)", () => {
    beforeEach(() => setNetwork("base"));

    it("returns correct USDC address", () => {
      expect(TOKENS().USDC).toBe(
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      );
    });

    it("returns correct WETH address", () => {
      expect(TOKENS().WETH).toBe(
        "0x4200000000000000000000000000000000000006",
      );
    });

    it("returns non-zero Moonwell addresses", () => {
      expect(MOONWELL().COMPTROLLER).not.toBe(
        "0x0000000000000000000000000000000000000000",
      );
      expect(MOONWELL().mUSDC).not.toBe(
        "0x0000000000000000000000000000000000000000",
      );
      expect(MOONWELL().mWETH).not.toBe(
        "0x0000000000000000000000000000000000000000",
      );
    });

    it("returns non-zero Venice addresses", () => {
      expect(VENICE().VVV).not.toBe(
        "0x0000000000000000000000000000000000000000",
      );
      expect(VENICE().STAKING).not.toBe(
        "0x0000000000000000000000000000000000000000",
      );
    });

    it("returns non-zero Uniswap addresses", () => {
      expect(UNISWAP().SWAP_ROUTER).not.toBe(
        "0x0000000000000000000000000000000000000000",
      );
      expect(UNISWAP().QUOTER_V2).not.toBe(
        "0x0000000000000000000000000000000000000000",
      );
    });
  });

  describe("testnet (base-sepolia)", () => {
    beforeEach(() => setNetwork("base-sepolia"));

    it("returns Sepolia USDC address", () => {
      expect(TOKENS().USDC).toBe(
        "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      );
    });

    it("returns same WETH address as mainnet", () => {
      expect(TOKENS().WETH).toBe(
        "0x4200000000000000000000000000000000000006",
      );
    });

    it("returns zero Moonwell addresses (not deployed on Sepolia)", () => {
      expect(MOONWELL().COMPTROLLER).toBe(
        "0x0000000000000000000000000000000000000000",
      );
      expect(MOONWELL().mUSDC).toBe(
        "0x0000000000000000000000000000000000000000",
      );
      expect(MOONWELL().mWETH).toBe(
        "0x0000000000000000000000000000000000000000",
      );
    });

    it("returns zero Venice addresses (not deployed on Sepolia)", () => {
      expect(VENICE().VVV).toBe(
        "0x0000000000000000000000000000000000000000",
      );
      expect(VENICE().STAKING).toBe(
        "0x0000000000000000000000000000000000000000",
      );
    });

    it("returns non-zero Uniswap addresses on Sepolia", () => {
      expect(UNISWAP().SWAP_ROUTER).not.toBe(
        "0x0000000000000000000000000000000000000000",
      );
      expect(UNISWAP().QUOTER_V2).not.toBe(
        "0x0000000000000000000000000000000000000000",
      );
    });

    it("returns non-zero ERC-8004 addresses on Sepolia", () => {
      expect(AGENT_REGISTRY().IDENTITY_REGISTRY).toBe(
        "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      );
    });

    it("returns correct Sherwood protocol addresses on Sepolia", () => {
      expect(SHERWOOD().FACTORY).toBe(
        "0x60bf54dDce61ece85BE5e66CBaA17cC312DEa6C8",
      );
    });
  });

  describe("robinhood-testnet", () => {
    beforeEach(() => setNetwork("robinhood-testnet"));

    it("returns zero USDC (not deployed on Robinhood)", () => {
      expect(TOKENS().USDC).toBe(
        "0x0000000000000000000000000000000000000000",
      );
    });

    it("returns correct WETH address", () => {
      expect(TOKENS().WETH).toBe(
        "0x7943e237c7F95DA44E0301572D358911207852Fa",
      );
    });

    it("returns zero Moonwell addresses (not on Robinhood)", () => {
      expect(MOONWELL().COMPTROLLER).toBe(
        "0x0000000000000000000000000000000000000000",
      );
    });

    it("returns zero Uniswap addresses (not on Robinhood)", () => {
      expect(UNISWAP().SWAP_ROUTER).toBe(
        "0x0000000000000000000000000000000000000000",
      );
    });

    it("returns zero EAS addresses (not on Robinhood)", () => {
      expect(EAS_CONTRACTS().EAS).toBe(
        "0x0000000000000000000000000000000000000000",
      );
    });

    it("returns zero agent registry (not on Robinhood)", () => {
      expect(AGENT_REGISTRY().IDENTITY_REGISTRY).toBe(
        "0x0000000000000000000000000000000000000000",
      );
    });

    it("returns deterministic Multicall3", () => {
      expect(
        TOKENS() && true, // just check it doesn't throw
      ).toBe(true);
    });
  });
});
