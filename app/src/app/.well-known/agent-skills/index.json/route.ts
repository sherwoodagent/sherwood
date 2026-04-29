import { NextRequest, NextResponse } from "next/server";

/**
 * /.well-known/agent-skills/index.json — Cloudflare Agent Skills Discovery
 * RFC v0.2.0 (https://agentskills.io).
 *
 * Sherwood ships two skills:
 *   1. `sherwood`           — the top-level fund-manager skill (skill.md)
 *   2. `sherwood-guardian`  — the guardian-staking + reviewer skill
 *
 * The sha256 digests are computed at request time by fetching the *same*
 * URLs we advertise. That guarantees an agent that downloads the skill
 * gets a body whose hash matches what we just published — no drift between
 * the index and the artifact.
 */

export const revalidate = 300;

const SKILL_URL = "https://sherwood.sh/skill.md";
const GUARDIAN_SKILL_URL = "https://sherwood.sh/skill-guardian.md";

async function sha256Of(url: string, request: NextRequest): Promise<string> {
  // In dev / preview, fetch from the same origin we're serving from so the
  // hash reflects the body the local server returns rather than prod.
  const u = new URL(url);
  const reqOrigin = request.nextUrl.origin;
  const fetchUrl =
    reqOrigin && (u.host === "sherwood.sh" || u.host.endsWith(".sherwood.sh"))
      ? new URL(u.pathname + u.search, reqOrigin).toString()
      : url;

  const res = await fetch(fetchUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${fetchUrl}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function GET(request: NextRequest) {
  // Compute hashes in parallel; tolerate failure on one without breaking
  // the index for the other.
  const [skillHash, guardianHash] = await Promise.allSettled([
    sha256Of(SKILL_URL, request),
    sha256Of(GUARDIAN_SKILL_URL, request),
  ]);

  const body = {
    $schema: "https://agentskills.io/schemas/v0.2.0/index.json",
    skills: [
      {
        name: "sherwood",
        type: "agent-skill",
        description:
          "Turns any agent into a fund manager. Creates autonomous investment syndicates that pool capital and run composable onchain strategies across DeFi, lending, and trading.",
        url: SKILL_URL,
        ...(skillHash.status === "fulfilled" && { sha256: skillHash.value }),
      },
      {
        name: "sherwood-guardian",
        type: "agent-skill",
        description:
          "Guardian operations for staked WOOD holders — stake, review proposal calldata, vote Block / Approve, claim rewards, and unstuck stuck proposals.",
        url: GUARDIAN_SKILL_URL,
        ...(guardianHash.status === "fulfilled" && {
          sha256: guardianHash.value,
        }),
      },
    ],
  };

  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
