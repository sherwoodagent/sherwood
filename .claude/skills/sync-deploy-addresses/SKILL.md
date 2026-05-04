---
name: sync-deploy-addresses
description: Propagate freshly-deployed contract addresses from contracts/chains/{chainId}.json to the three downstream mirrors that don't auto-update — cli/src/lib/addresses.ts, mintlify-docs/reference/deployments.mdx, and skill/ADDRESSES.md. Use after running a deploy script that wrote new addresses to contracts/chains/{chainId}.json.
disable-model-invocation: true
---

# Sync Deploy Addresses

Sherwood deploy scripts write to `contracts/chains/{chainId}.json` automatically, but three other locations mirror those addresses and must be hand-edited (per CLAUDE.md "Address Management"):

1. `cli/src/lib/addresses.ts`
2. `mintlify-docs/reference/deployments.mdx`
3. `skill/ADDRESSES.md`

Drift between any of them silently breaks the CLI, the docs, or the agent runtime. This skill propagates the canonical JSON to all three.

## Usage

`/sync-deploy-addresses [--chain <id>]`

Default: detects which `contracts/chains/{id}.json` files have changed since `git merge-base origin/main HEAD` and syncs each one. Pass `--chain 8453` to scope to a single chain.

## Workflow

For each changed `contracts/chains/{chainId}.json`:

1. **Read** the JSON. Build a `{ KEY: address }` map (CAPS_SNAKE_CASE keys: `SYNDICATE_FACTORY`, `SYNDICATE_GOVERNOR`, `GUARDIAN_REGISTRY`, etc.).

2. **CLI** (`cli/src/lib/addresses.ts`): grep for the chain's `*_ADDRESSES` const block (e.g. `BASE_ADDRESSES`, `HYPEREVM_ADDRESSES`). For each key in the JSON, find the matching field (camelCase: `syndicateFactory`, `syndicateGovernor`, …) and update the address literal. Preserve formatting and comments. Add new keys at the end of the block if missing.

3. **Docs** (`mintlify-docs/reference/deployments.mdx`): find the table row for the chain (Base / Base Sepolia / HyperEVM). Update each address cell. Preserve any annotation suffixes like `(redeployed 2026-04)`.

4. **Skill registry** (`skill/ADDRESSES.md`): update the chain's address section. This file is consumed by the Hermes agent runtime, so addresses must be **lower-cased** with no truncation.

5. **Verify**: print a 3-line diff summary per file changed. Run `cd cli && node_modules/.bin/tsc --noEmit` to confirm the CLI still typechecks (catches typos in the field names).

6. **Commit reminder**: do NOT auto-commit — print the suggested commit message:
   ```
   chore: sync {chain-name} addresses across cli/docs/skill mirrors

   - cli/src/lib/addresses.ts
   - mintlify-docs/reference/deployments.mdx
   - skill/ADDRESSES.md

   Source: contracts/chains/{chainId}.json
   ```

## Guardrails

- If a JSON key has no obvious counterpart in `addresses.ts` (e.g. a brand-new contract), STOP and ask the user where to add it. Don't guess camelCase.
- If `mintlify-docs/` has uncommitted changes (it's a submodule and frequently does), warn that the submodule pointer in the parent repo will need a separate commit.
- Never edit `contracts/chains/{chainId}.json` itself — that's the source of truth, written by deploy scripts.

## Skipping verification

Type-check failure means a downstream caller reads a renamed/removed field. Either the CLI needs an update (call site change) or the JSON has a typo. Don't silently bypass — surface to the user.
