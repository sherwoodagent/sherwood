import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setNetwork,
  getNetwork,
  getChain,
  getRpcUrl,
  getRpcUrls,
  getExplorerUrl,
  isTestnet,
  getChainConfig,
  VALID_NETWORKS,
} from "./network.js";

// Enable testnet for all tests
beforeEach(() => {
  process.env.ENABLE_TESTNET = "true";
});

describe("network", () => {
  beforeEach(() => {
    // Reset to default
    setNetwork("base");
  });

  describe("setNetwork / getNetwork", () => {
    it("defaults to base", () => {
      expect(getNetwork()).toBe("base");
    });

    it("can be set to base-sepolia", () => {
      setNetwork("base-sepolia");
      expect(getNetwork()).toBe("base-sepolia");
    });

    it("can be set to robinhood-testnet", () => {
      setNetwork("robinhood-testnet");
      expect(getNetwork()).toBe("robinhood-testnet");
    });

    it("can be set back to base", () => {
      setNetwork("base-sepolia");
      setNetwork("base");
      expect(getNetwork()).toBe("base");
    });

    it("throws for unknown network", () => {
      expect(() => setNetwork("invalid" as any)).toThrow("Unknown network");
    });
  });

  describe("ENABLE_TESTNET gating", () => {
    it("blocks testnets when ENABLE_TESTNET is not set", () => {
      delete process.env.ENABLE_TESTNET;
      expect(() => setNetwork("base-sepolia")).toThrow("disabled");
      expect(() => setNetwork("robinhood-testnet")).toThrow("disabled");
    });

    it("allows base when ENABLE_TESTNET is not set", () => {
      delete process.env.ENABLE_TESTNET;
      expect(() => setNetwork("base")).not.toThrow();
    });

    it("allows testnets when ENABLE_TESTNET=true", () => {
      process.env.ENABLE_TESTNET = "true";
      expect(() => setNetwork("base-sepolia")).not.toThrow();
      expect(() => setNetwork("robinhood-testnet")).not.toThrow();
    });
  });

  describe("getChain", () => {
    it("returns base chain for mainnet", () => {
      setNetwork("base");
      const chain = getChain();
      expect(chain.id).toBe(8453);
      expect(chain.name).toBe("Base");
    });

    it("returns baseSepolia chain for testnet", () => {
      setNetwork("base-sepolia");
      const chain = getChain();
      expect(chain.id).toBe(84532);
      expect(chain.name).toBe("Base Sepolia");
    });

    it("returns robinhoodTestnet chain", () => {
      setNetwork("robinhood-testnet");
      const chain = getChain();
      expect(chain.id).toBe(46630);
      expect(chain.name).toBe("Robinhood Chain Testnet");
    });
  });

  describe("getRpcUrl", () => {
    it("falls back to public base URL when no env var", () => {
      const originalEnv = process.env.BASE_RPC_URL;
      delete process.env.BASE_RPC_URL;
      setNetwork("base");
      expect(getRpcUrl()).toBe("https://base-rpc.publicnode.com");
      if (originalEnv) process.env.BASE_RPC_URL = originalEnv;
    });

    it("falls back to public sepolia URL when no env var", () => {
      const originalEnv = process.env.BASE_SEPOLIA_RPC_URL;
      delete process.env.BASE_SEPOLIA_RPC_URL;
      setNetwork("base-sepolia");
      expect(getRpcUrl()).toBe("https://base-sepolia-rpc.publicnode.com");
      if (originalEnv) process.env.BASE_SEPOLIA_RPC_URL = originalEnv;
    });

    it("falls back to public robinhood URL", () => {
      setNetwork("robinhood-testnet");
      expect(getRpcUrl()).toBe("https://rpc.testnet.chain.robinhood.com");
    });

    it("uses env var when set", () => {
      const originalEnv = process.env.BASE_RPC_URL;
      process.env.BASE_RPC_URL = "https://custom-rpc.example.com";
      setNetwork("base");
      expect(getRpcUrl()).toBe("https://custom-rpc.example.com");
      if (originalEnv) process.env.BASE_RPC_URL = originalEnv;
      else delete process.env.BASE_RPC_URL;
    });
  });

  describe("getRpcUrls", () => {
    it("returns full Base fallback list in order", () => {
      const originalEnv = process.env.BASE_RPC_URL;
      delete process.env.BASE_RPC_URL;
      setNetwork("base");
      expect(getRpcUrls()).toEqual([
        "https://base-rpc.publicnode.com",
        "https://mainnet.base.org",
        "https://base.llamarpc.com",
        "https://base.drpc.org",
      ]);
      if (originalEnv) process.env.BASE_RPC_URL = originalEnv;
    });

    it("prepends env var ahead of public fallbacks", () => {
      const originalEnv = process.env.BASE_RPC_URL;
      process.env.BASE_RPC_URL = "https://custom-rpc.example.com";
      setNetwork("base");
      const urls = getRpcUrls();
      expect(urls[0]).toBe("https://custom-rpc.example.com");
      expect(urls).toContain("https://base-rpc.publicnode.com");
      if (originalEnv) process.env.BASE_RPC_URL = originalEnv;
      else delete process.env.BASE_RPC_URL;
    });

    it("dedupes when env var matches a public fallback entry", () => {
      const originalEnv = process.env.BASE_RPC_URL;
      process.env.BASE_RPC_URL = "https://mainnet.base.org";
      setNetwork("base");
      const urls = getRpcUrls();
      expect(urls.filter((u) => u === "https://mainnet.base.org").length).toBe(
        1,
      );
      if (originalEnv) process.env.BASE_RPC_URL = originalEnv;
      else delete process.env.BASE_RPC_URL;
    });
  });

  describe("getExplorerUrl", () => {
    it("returns basescan URL for mainnet", () => {
      setNetwork("base");
      const url = getExplorerUrl("0xabc123");
      expect(url).toBe("https://basescan.org/tx/0xabc123");
    });

    it("returns sepolia basescan URL for testnet", () => {
      setNetwork("base-sepolia");
      const url = getExplorerUrl("0xabc123");
      expect(url).toBe("https://sepolia.basescan.org/tx/0xabc123");
    });

    it("returns blockscout URL for robinhood testnet", () => {
      setNetwork("robinhood-testnet");
      const url = getExplorerUrl("0xabc123");
      expect(url).toBe(
        "https://explorer.testnet.chain.robinhood.com/tx/0xabc123",
      );
    });
  });

  describe("isTestnet", () => {
    it("returns false for base", () => {
      setNetwork("base");
      expect(isTestnet()).toBe(false);
    });

    it("returns true for base-sepolia", () => {
      setNetwork("base-sepolia");
      expect(isTestnet()).toBe(true);
    });

    it("returns true for robinhood-testnet", () => {
      setNetwork("robinhood-testnet");
      expect(isTestnet()).toBe(true);
    });
  });

  describe("getChainConfig", () => {
    it("returns EAS config for base", () => {
      setNetwork("base");
      const cfg = getChainConfig();
      expect(cfg.easGraphqlUrl).toBe("https://base.easscan.org/graphql");
      expect(cfg.xmtpEnv).toBe("production");
    });

    it("returns null EAS config for robinhood-testnet", () => {
      setNetwork("robinhood-testnet");
      const cfg = getChainConfig();
      expect(cfg.easGraphqlUrl).toBeNull();
      expect(cfg.easScanHost).toBeNull();
      expect(cfg.xmtpEnv).toBe("dev");
    });
  });

  describe("VALID_NETWORKS", () => {
    it("contains all supported networks", () => {
      expect(VALID_NETWORKS).toContain("base");
      expect(VALID_NETWORKS).toContain("base-sepolia");
      expect(VALID_NETWORKS).toContain("robinhood-testnet");
    });
  });
});
