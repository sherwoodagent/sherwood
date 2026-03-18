import { describe, it, expect, beforeEach } from "vitest";
import { setNetwork } from "./network.js";
import { TOKENS, MOONWELL, UNISWAP, VENICE, AGENT_REGISTRY, SHERWOOD } from "./addresses.js";

describe("addresses", () => {
  describe("mainnet (base)", () => {
    beforeEach(() => setNetwork("base"));

    it("returns correct USDC address", () => {
      expect(TOKENS().USDC).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    });

    it("returns correct WETH address", () => {
      expect(TOKENS().WETH).toBe("0x4200000000000000000000000000000000000006");
    });

    it("returns non-zero Moonwell addresses", () => {
      expect(MOONWELL().COMPTROLLER).not.toBe("0x0000000000000000000000000000000000000000");
      expect(MOONWELL().mUSDC).not.toBe("0x0000000000000000000000000000000000000000");
      expect(MOONWELL().mWETH).not.toBe("0x0000000000000000000000000000000000000000");
    });

    it("returns non-zero Venice addresses", () => {
      expect(VENICE().VVV).not.toBe("0x0000000000000000000000000000000000000000");
      expect(VENICE().STAKING).not.toBe("0x0000000000000000000000000000000000000000");
    });

    it("returns non-zero Uniswap addresses", () => {
      expect(UNISWAP().SWAP_ROUTER).not.toBe("0x0000000000000000000000000000000000000000");
      expect(UNISWAP().QUOTER_V2).not.toBe("0x0000000000000000000000000000000000000000");
    });
  });

  describe("testnet (base-sepolia)", () => {
    beforeEach(() => setNetwork("base-sepolia"));

    it("returns Sepolia USDC address", () => {
      expect(TOKENS().USDC).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    });

    it("returns same WETH address as mainnet", () => {
      expect(TOKENS().WETH).toBe("0x4200000000000000000000000000000000000006");
    });

    it("returns zero Moonwell addresses (not deployed on Sepolia)", () => {
      expect(MOONWELL().COMPTROLLER).toBe("0x0000000000000000000000000000000000000000");
      expect(MOONWELL().mUSDC).toBe("0x0000000000000000000000000000000000000000");
      expect(MOONWELL().mWETH).toBe("0x0000000000000000000000000000000000000000");
    });

    it("returns zero Venice addresses (not deployed on Sepolia)", () => {
      expect(VENICE().VVV).toBe("0x0000000000000000000000000000000000000000");
      expect(VENICE().STAKING).toBe("0x0000000000000000000000000000000000000000");
    });

    it("returns non-zero Uniswap addresses on Sepolia", () => {
      expect(UNISWAP().SWAP_ROUTER).not.toBe("0x0000000000000000000000000000000000000000");
      expect(UNISWAP().QUOTER_V2).not.toBe("0x0000000000000000000000000000000000000000");
    });

    it("returns non-zero ERC-8004 addresses on Sepolia", () => {
      expect(AGENT_REGISTRY().IDENTITY_REGISTRY).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
    });

    it("returns correct Sherwood protocol addresses on Sepolia", () => {
      expect(SHERWOOD().FACTORY).toBe("0x60bf54dDce61ece85BE5e66CBaA17cC312DEa6C8");
      expect(SHERWOOD().STRATEGY_REGISTRY).toBe("0xf1e6E9bd1a735B54F383b18ad6603Ddd566C71cE");
    });
  });
});
