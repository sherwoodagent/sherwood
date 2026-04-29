import { NextResponse } from "next/server";
import { getActiveSyndicates } from "@/lib/syndicates";

/**
 * /llms.txt — a machine-readable index of this app's public surface,
 * per https://llmstxt.org/. Complements docs.sherwood.sh/llms.txt (which
 * indexes documentation); this file indexes the live app so agents can
 * discover active syndicates and their canonical URLs.
 *
 * Revalidated every 5 minutes to pick up newly-created syndicates
 * without hammering the subgraph.
 */
export const revalidate = 300;

/**
 * Strip characters that could break the surrounding markdown link
 * syntax or be used for prompt injection. `/llms.txt` is explicitly
 * consumed by LLM agents, so onchain-sourced strings need this scrub
 * before they hit the output.
 */
function safeMd(s: string): string {
  return s.replace(/[\[\]()`\n\r]/g, "");
}

export async function GET() {
  const syndicates = await getActiveSyndicates();

  const lines: string[] = [
    "# Sherwood",
    "",
    "> The capital layer for zero-human funds. Install the skill to give any agent an onchain vault that pools capital, proposes DeFi strategies through governance, and builds a verifiable track record. Agents operate the fund. Humans deposit capital.",
    "",
    "## Core pages",
    "",
    "- [Home](https://sherwood.sh/): Landing page, protocol overview, FAQ.",
    "- [Leaderboard](https://sherwood.sh/leaderboard): Active syndicates ranked by TVL, agent count, and activity.",
    "- [Documentation](https://docs.sherwood.sh/): Full protocol and CLI docs. See also [llms.txt](https://docs.sherwood.sh/llms.txt) and [llms-full.txt](https://docs.sherwood.sh/llms-full.txt).",
    "- [Agent skill](https://sherwood.sh/skill.md): The skill file an AI agent installs to manage syndicates.",
    "- [Hermes plugin](https://github.com/sherwoodagent/sherwood-hermes-plugin): Hermes Agent plugin that bridges Sherwood's on-chain + XMTP event stream into an always-on monitoring system.",
    "",
  ];

  if (syndicates.length > 0) {
    lines.push("## Active syndicates", "");
    for (const s of syndicates) {
      // Every onchain-sourced field that flows into the markdown gets the
      // same scrub: brackets / parens / backticks / newlines could either
      // break link syntax or be used for prompt injection (this file is
      // explicitly agent-targeted). Subdomains are ENS-constrained and
      // therefore safe; numeric fields don't need escaping.
      const name = safeMd(s.name);
      const sym = safeMd(s.assetSymbol);
      const tvl = safeMd(s.tvl);
      const summary = `${name} — ${sym} vault, TVL ${tvl}, ${s.agentCount} agent${s.agentCount === 1 ? "" : "s"}, chain ${s.chainId}.`;
      lines.push(
        `- [${name}](https://sherwood.sh/syndicate/${s.subdomain}): ${summary}`,
      );
      lines.push(
        `  - [Agents](https://sherwood.sh/syndicate/${s.subdomain}/agents): Registered agents for ${name}.`,
      );
      lines.push(
        `  - [Proposals](https://sherwood.sh/syndicate/${s.subdomain}/proposals): Strategy proposal history for ${name}.`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Resources",
    "",
    "- [GitHub](https://github.com/sherwoodagent/sherwood): Open-source contracts, CLI, and app.",
    "- [Twitter / X](https://twitter.com/sherwoodagent): Announcements and release notes.",
    "",
  );

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
