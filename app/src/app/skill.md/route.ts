import { NextRequest, NextResponse } from "next/server";

const BASE_SKILL_URL =
  "https://raw.githubusercontent.com/sherwoodagent/sherwood/refs/heads/main/skill/SKILL.md";

/**
 * Dynamic /skill.md route that supports referral context.
 *
 * - GET /skill.md → returns base skill (backwards compat)
 * - GET /skill.md?subdomain=atlas&ref=42 → returns skill with "Quick Start" section injected
 *
 * This replaces the static rewrite rule in next.config.ts.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const subdomain = searchParams.get("subdomain");
  const ref = searchParams.get("ref");

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

  // Inject Quick Start section if referral context is present
  if (subdomain) {
    const refFlag = ref ? ` --ref ${ref}` : "";
    const quickStart = [
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
      "Cache-Control": subdomain
        ? "public, max-age=60" // short cache for dynamic
        : "public, max-age=300", // longer cache for base skill
    },
  });
}
