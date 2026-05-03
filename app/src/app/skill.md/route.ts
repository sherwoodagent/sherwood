import { NextRequest, NextResponse } from "next/server";

const BASE_SKILL_URL =
  "https://raw.githubusercontent.com/sherwoodagent/sherwood/refs/heads/main/skill/SKILL.md";

/** Beta strategies the agent can be told to test from the landing page.
 *  Each entry produces a Quick Start section that walks the user through
 *  create → deposit → propose for that specific strategy. */
const STRATEGY_QUICKSTARTS: Record<
  string,
  { title: string; subtitle: string; templateName: string; docsUrl: string; description: string }
> = {
  portfolio: {
    title: "Portfolio Strategy (Uniswap)",
    subtitle: "Weighted basket of tokens with on-chain rebalancing via Uniswap multi-hop routing.",
    templateName: "portfolio",
    docsUrl: "https://docs.sherwood.sh/protocol/strategies/portfolio",
    description:
      "Manages up to 20 tokens at target weights. Execute swaps the vault's USDC into the basket; the proposer can `rebalance()` or `rebalanceDelta()` while live; settle sells everything back. Chainlink Data Streams support delta-rebalancing for gas efficiency.",
  },
  "hyperliquid-perp": {
    title: "Hyperliquid Perp Strategy",
    subtitle: "Leveraged perpetual futures on Hyperliquid via HyperEVM precompiles.",
    templateName: "hyperliquid-perp",
    docsUrl: "https://docs.sherwood.sh/protocol/strategies/hyperliquid-perp",
    description:
      "Pulls USDC from the vault into HyperCore perp margin. The proposer drives `openLong` / `setStopLoss` / `close` via `updateParams`. Position state reads live from HyperCore. **HyperEVM mainnet only** — caps `leverage`, `maxPositionSize`, and `maxTradesPerDay` set at init.",
  },
};

/**
 * Dynamic /skill.md route that supports referral and strategy context.
 *
 * - GET /skill.md → returns base skill (backwards compat)
 * - GET /skill.md?subdomain=atlas&ref=42 → injects "Join this syndicate" Quick Start
 * - GET /skill.md?strategy=portfolio → injects "Test this strategy" Quick Start
 *
 * This replaces the static rewrite rule in next.config.ts.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const subdomain = searchParams.get("subdomain");
  const ref = searchParams.get("ref");
  const strategy = searchParams.get("strategy");

  // Fetch the base skill from GitHub
  const res = await fetch(BASE_SKILL_URL, {
    next: { revalidate: 300 }, // cache for 5 minutes
  });

  if (!res.ok) {
    return NextResponse.json(
      { error: "Failed to fetch skill" },
      { status: 502 },
    );
  }

  let skillContent = await res.text();

  let quickStart = "";

  // Inject Quick Start section if referral context is present
  if (subdomain) {
    const refFlag = ref ? ` --ref ${ref}` : "";
    quickStart = [
      "",
      "## Quick Start — Join this syndicate",
      "",
      `Join **${subdomain}.sherwoodagent.eth**:`,
      "",
      "```bash",
      `sherwood syndicate join --subdomain ${subdomain}${refFlag}`,
      "```",
      "",
      "---",
      "",
    ].join("\n");
  } else if (strategy && STRATEGY_QUICKSTARTS[strategy]) {
    const s = STRATEGY_QUICKSTARTS[strategy];
    quickStart = [
      "",
      `## Quick Start — Test the ${s.title} (Beta)`,
      "",
      `**The user wants to evaluate the ${s.title}.** ${s.subtitle}`,
      "",
      `${s.description}`,
      "",
      `**First, brief the user on the strategy.** Walk through what it does and the risks. Reference the docs: ${s.docsUrl}`,
      "",
      "**Then guide them through the three steps below in order, asking for confirmation between each.** Do not run them silently.",
      "",
      "### Step 1 — Create a syndicate (if they don't already have one)",
      "",
      "```bash",
      `sherwood syndicate create --name "<name>" --asset USDC -y`,
      "```",
      "",
      "### Step 2 — Deposit USDC into the vault",
      "",
      "```bash",
      "sherwood deposit <amount>",
      "```",
      "",
      "### Step 3 — Propose this strategy",
      "",
      "```bash",
      `sherwood proposal create --template ${s.templateName}`,
      "```",
      "",
      `Then walk the user through reviewing the proposal calldata before voting and execution. Beta caveat: this strategy is in beta — explain that strategy parameters and adapter addresses may still change.`,
      "",
      "---",
      "",
    ].join("\n");
  }

  if (quickStart) {
    // Insert after the first heading (# title line) or at the top
    const firstHeadingEnd = skillContent.indexOf("\n", skillContent.indexOf("# "));
    if (firstHeadingEnd > 0) {
      skillContent =
        skillContent.slice(0, firstHeadingEnd + 1) +
        quickStart +
        skillContent.slice(firstHeadingEnd + 1);
    } else {
      skillContent = quickStart + skillContent;
    }
  }

  return new NextResponse(skillContent, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": quickStart
        ? "public, max-age=60" // short cache for dynamic
        : "public, max-age=300", // longer cache for base skill
    },
  });
}
