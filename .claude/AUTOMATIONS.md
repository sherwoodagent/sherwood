# Claude Code Automations (Sherwood)

Project-level automations checked into the repo so every contributor gets the same Claude Code behavior on checkout.

## Hooks (`.claude/settings.json`)

### `PreToolUse` — block push to stale `imthatcarlos` remote
Catches `git push origin <branch>` when `origin` still points at `imthatcarlos/sherwood`. Tells you to use `git push sherwoodagent <branch>` instead. Exits with code 2 so Claude sees the block and re-routes.

### `PostToolUse` — auto `forge fmt` on Solidity write
Runs `forge fmt <file>` after any Edit/Write/MultiEdit to a `.sol` file under `contracts/`. Keeps `forge fmt --check` in CI from failing. No-op on non-Solidity edits.

## Skills (`.claude/skills/`)

### `sync-deploy-addresses` (user-invoked: `/sync-deploy-addresses`)
After a deploy script writes a new `contracts/chains/{chainId}.json`, this propagates the addresses to the three downstream mirrors that don't auto-update:
1. `cli/src/lib/addresses.ts`
2. `mintlify-docs/reference/deployments.mdx`
3. `skill/ADDRESSES.md`

Runs `tsc --noEmit` to verify CLI wiring, prints a 3-line diff per file, suggests a commit message — never auto-commits.

## MCP Servers (`.mcp.json`)

### GitHub MCP
Replaces the dozen `gh api repos/... | python3 -c '...'` shell-escape gymnastics already in `.claude/settings.local.json`. Native tool calls for issues, PRs, comments, reviews.

**Setup**: `export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...` in your shell profile, then restart Claude Code. The `.mcp.json` is checked in so teammates only need the env var.

### Foundry MCP (not yet installed — by design)
There's no canonical / well-maintained Foundry MCP server today. Two paths when you want one:
- **Build it**: use the `mcp-builder` plugin to wrap `forge` / `cast` / `anvil` as MCP tools. Useful surface: `cast sig`, `cast call`, `forge build --sizes --json`, ABI/storage-slot lookups for the selector registry maintenance and the bytecode-budget tracking documented in `CLAUDE.md`.
- **Skip it**: continue running `cast`/`forge` via Bash. The CLAUDE.md `cast sig` recipes already cover most needs. Revisit if selector decoding or ABI inspection becomes a daily pattern.

## Why these specific automations

Each one fixes a real pain that hit this codebase:
- **forge fmt hook**: CLAUDE.md says "always run `forge fmt` locally before pushing" — this stops being a manual rule.
- **push guard**: a PR creation in May 2026 failed because the canonical remote moved from `imthatcarlos` to `sherwoodagent` and `git push -u origin` silently went to the wrong fork.
- **sync-deploy-addresses**: 4-way address mirror is the #1 doc-drift source called out in the punchlist.
- **GitHub MCP**: `.claude/settings.local.json` already has 9+ permission entries for python3 shell-escape JSON parsing of `gh api` output. That's the smell — switch to native tools.

## Not added (deliberately)

- **Multi-chain address validator** — overlapping with `sync-deploy-addresses`; revisit if drift between Base and HyperEVM JSONs becomes a recurring issue.
- **Bytecode budget watcher** — useful but `forge build --sizes` already exists; CLAUDE.md tracks margins by hand. Add when an edit silently blows the limit (it hasn't yet).
- **Enum sync check skill** — superseded by the CLAUDE.md guardrail added in the same session. Promote to a skill if the rule gets ignored.
