/**
 * E2E test: Documentation callout verification
 *
 * 1. Verifies the WOOD "Coming soon" callout exists in the mintlify-docs source
 *    (economics.mdx in the submodule) — ensures the content hasn't been accidentally removed.
 * 2. Checks if docs.sherwood.sh/protocol/governance/economics reflects the callout
 *    (deploy status check — warns but does not fail if site not yet updated).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { SimConfig, SimState, SimLogger } from "./types.js";

// Path to mintlify-docs submodule relative to cli/
const DOCS_ROOT = path.resolve(import.meta.dirname ?? __dirname, "../../../mintlify-docs");
const ECONOMICS_MDX = path.join(DOCS_ROOT, "protocol/governance/economics.mdx");
const LIVE_URL = "https://docs.sherwood.sh/protocol/governance/economics";

export async function testDocs(_config: SimConfig, _state: SimState, _logger?: SimLogger): Promise<void> {
  // ── Test 1: Source file contains "Coming soon" callout ──
  let source: string;
  try {
    source = readFileSync(ECONOMICS_MDX, "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read economics.mdx at ${ECONOMICS_MDX}.\n` +
      `Is the mintlify-docs submodule initialised? Run: git submodule update --init\n` +
      `Error: ${(err as Error).message}`,
    );
  }

  const hasComingSoon = source.includes("Coming soon") || source.includes("coming soon");
  const hasWoodSection = source.includes("WOOD") || source.includes("wood");

  if (!hasWoodSection) {
    throw new Error("economics.mdx is missing the WOOD/SHARES section entirely.");
  }
  if (!hasComingSoon) {
    throw new Error(
      'economics.mdx WOOD section is missing the "Coming soon" callout.\n' +
      'Expected: "Coming soon" text near the WOOD/SHARES Liquidity Pools heading.\n' +
      'This callout communicates to users that the feature is not yet deployed.',
    );
  }

  console.log('  ✓ economics.mdx has WOOD section with "Coming soon" callout (source verified)');

  // ── Test 2: Live site check (non-blocking) ──
  try {
    const res = await fetch(LIVE_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.log(`  ⚠  Live docs returned ${res.status} — deploy may be pending`);
      return;
    }
    const html = await res.text();
    // Mintlify renders mdx → HTML; the text "Coming soon" should appear in the page body
    if (html.includes("Coming soon") || html.includes("coming soon")) {
      console.log("  ✓ docs.sherwood.sh shows \"Coming soon\" callout (live deploy verified)");
    } else {
      console.log("  ⚠  docs.sherwood.sh does not yet show \"Coming soon\" — submodule deploy pending");
    }
  } catch {
    console.log("  ⚠  Could not reach docs.sherwood.sh — skipping live deploy check");
  }
}
