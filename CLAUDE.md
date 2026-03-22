# CLAUDE.md — Sherwood Development Guide

## Git Workflow

**NEVER commit directly to `main`.** Always:

1. Create a feature branch: `git checkout -b <type>/<short-description>`
   - Types: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`
   - Examples: `feat/vault-agent-registry`, `fix/usdc-decimals`, `test/vault-redeem`

2. Make atomic commits with conventional commit messages:
   - `feat: add syndicate-level caps to vault contract`
   - `fix: account for USDC 6 decimals in deposit math`
   - `test: vault redeem returns pro-rata shares`
   - `docs: update README with vault architecture`

3. Push the branch and create a PR with the template (auto-loaded from `.github/`)

4. PR description must include:
   - Which package is touched (`contracts`, `cli`, `app`)
   - What changed (adds / fixes / refactors)
   - How it was tested (forge test output, manual steps, etc.)

5. Never force push, never delete branches, never rewrite history.

## Project Structure

```
contracts/      Foundry — Solidity smart contracts
cli/            TypeScript CLI (viem, Commander)
app/            Next.js dashboard
mintlify-docs/  Mintlify documentation site (git submodule → docs.sherwood.sh)
```

## Documentation

Full protocol and CLI documentation: **https://docs.sherwood.sh/**

Source lives in `mintlify-docs/` (git submodule pointing to `imthatcarlos/mintlify-docs`).

LLM-friendly versions:
- `https://docs.sherwood.sh/llms.txt` — structured index
- `https://docs.sherwood.sh/llms-full.txt` — complete docs in a single file

Key sections: [Learn](https://docs.sherwood.sh/learn/quickstart) | [Protocol](https://docs.sherwood.sh/protocol/architecture) | [CLI](https://docs.sherwood.sh/cli/commands) | [Reference](https://docs.sherwood.sh/reference/deployments)

**Keep docs in sync.** When changes touch contracts, CLI, or app, update the corresponding pages in `mintlify-docs/`:
- Contract changes → `protocol/architecture.mdx`, `protocol/governance/*.mdx`
- CLI command changes → `cli/commands.mdx`, `cli/governance-commands.mdx`
- Address/deployment changes → `contracts/chains/{chainId}.json` (auto-written by deploy scripts), `cli/src/lib/addresses.ts`, `reference/deployments.mdx`, `skill/ADDRESSES.md`
- Integration changes → `reference/integrations/*.mdx`
- New features → `learn/concepts.mdx` if it introduces a new primitive

## Contracts

- Solidity 0.8.28, Foundry, OpenZeppelin upgradeable (UUPS)
- USDC on Base has **6 decimals** not 18 — always account for this
- Use SafeERC20 for all token transfers
- Run `forge build` and `forge test` before every PR
- Run `forge fmt` before committing
- SyndicateGovernor is near the EIP-170 bytecode limit (~23.8k / 24.6k) — avoid adding large functions without deduplicating first

### Address Management

- Deploy scripts auto-write to `contracts/chains/{chainId}.json` (CAPS_SNAKE_CASE keys: `SYNDICATE_FACTORY`, `SYNDICATE_GOVERNOR`, etc.)
- Admin scripts (QueueParams, FinalizeParams) read from the same JSON — no env vars needed
- All scripts inherit `script/ScriptBase.sol` for shared helpers (`_writeAddresses`, `_readAddress`, `_checkAddr`, `_checkUint`)
- After redeployment, also update: `cli/src/lib/addresses.ts`, `mintlify-docs/reference/deployments.mdx`

### Architecture

- **SyndicateVault** — ERC-4626 vault with ERC20Votes for governance. Standard `redeem()`/`withdraw()` for LP exits (no custom ragequit). `_decimalsOffset()` = `asset.decimals()` for first-depositor inflation protection (shares have 12 decimals for USDC). Deposits and `rescueERC20` are blocked during active proposals (`redemptionsLocked()`).
- **SyndicateGovernor** — Proposal lifecycle, optimistic voting, execution, settlement, collaborative proposals. Inherits `GovernorParameters` (abstract) for all parameter setters, validation, and timelock logic.
- **GovernorParameters** — Abstract contract with constants, bounds, 10 parameter setters (all timelock-gated: queue → delay → finalize), and validation helpers. Extracted to reduce governor bytecode.
- **SyndicateFactory** — UUPS upgradeable factory. Deploys vault + registers it with the governor. Creation fee, vault upgrades, paginated queries. Owner-configurable: `setVaultImpl`, `setGovernor`, `setCreationFee`, `setManagementFeeBps`, `setUpgradesEnabled`.
- **BatchExecutorLib** — Stateless library for `delegatecall`-based batch execution.
- **Strategy Templates** — `BaseStrategy` (abstract) + `MoonwellSupplyStrategy` + `AerodromeLPStrategy`. ERC-1167 clonable. Vault calls `execute()`/`settle()` via batch.

### Governor Key Concepts

- **Optimistic governance** — Proposals pass by default after voting period ends. Only rejected if AGAINST votes reach `vetoThresholdBps`. Vault owner can also `vetoProposal()` to reject Pending/Approved proposals.
- **VoteType enum** — `For`, `Against`, `Abstain` (replaces boolean vote).
- **Separate `executeCalls` / `settlementCalls`** — Proposals store opening and closing calls in two distinct arrays. No `splitIndex`.
- **Parameter timelock** — All governance parameter changes are queued with a configurable delay (6h–7d). Owner calls the setter (queues), waits, then calls `finalizeParameterChange(paramKey)`. Parameters are re-validated at finalize time. Owner can `cancelParameterChange(paramKey)` at any time.
- **Protocol fee** — `protocolFeeBps` + `protocolFeeRecipient` taken from gross profit before agent and management fees. Timelocked. Max 10%. Setting nonzero `protocolFeeBps` requires `protocolFeeRecipient` to be set first.
- **Two settlement paths**: (1) `settleProposal` — proposer can call anytime, anyone else after strategy duration; (2) `emergencySettle` — vault owner after duration, tries pre-committed calls first then falls back to custom calls.
- **Vault reads governor from factory** — no `setGovernor` on vault, no lock/unlock storage. `redemptionsLocked()` checks `governor.getActiveProposal()` directly.

## CLI

- TypeScript, viem for chain interaction, Commander for CLI
- Provider pattern: each DeFi protocol = a provider with standard interface
- `npm run typecheck` before every PR
- **Distribution**: Published to npm as `@sherwoodagent/cli` (`npm i -g @sherwoodagent/cli`). Standalone binary via GitHub releases as secondary (no chat/XMTP support).
- **Version bumps are mandatory for every PR that touches `cli/` code.** Bump the `version` field in `cli/package.json` before creating the PR. Stay on `0.x` until mainnet — use **minor** bumps (`0.3.0` → `0.4.0`) for new features or breaking changes, **patch** bumps (`0.3.5` → `0.3.6`) for bug fixes and small improvements. First mainnet release will be `1.0.0`. A merge to main with a new version triggers an npm publish automatically.

## Chat (XMTP)

- Encrypted group messaging via `@xmtp/cli` subprocess — no native bindings, works on all platforms (Debian 12, Ubuntu 22.04, OpenClaw sandboxes)
- Each syndicate gets an XMTP group on creation, group ID stored as ENS text record + cached locally
- Creator is super admin — only they can add members via `syndicate add`
- Agents auto-added to chat after registration, with `AGENT_REGISTERED` lifecycle message
- All messages sent as JSON `ChatEnvelope` text (markdown and reactions encoded as envelope types)
- `--public-chat` on `syndicate create` / `--public` on `chat init` enables public chat (adds dashboard spectator)
- `sherwood chat <name> public --on/--off` toggles dashboard spectator access after creation
- Config stored at `~/.sherwood/config.json` (XMTP DB encryption key, group ID cache)
- Private key auto-synced from `~/.sherwood/config.json` → `~/.xmtp/.env` on first XMTP operation

### Chat Commands
- `sherwood chat <name>` — stream messages in real-time
- `sherwood chat <name> send "msg"` — send a text message
- `sherwood chat <name> send "msg" --markdown` — send formatted markdown
- `sherwood chat <name> react <id> <emoji>` — react to a message
- `sherwood chat <name> log` — show recent messages
- `sherwood chat <name> members` — list group members
- `sherwood chat <name> add <addr>` — add member (creator only)
- `sherwood chat <name> init [--force] [--public]` — create XMTP group + write ENS record (creator only)
- `sherwood chat <name> public --on/--off` — toggle dashboard spectator access

### Agent Chat Onboarding
- XMTP requires each wallet to have initialized an XMTP client at least once before it can be added to groups
- `syndicate join` auto-initializes the agent's XMTP identity (calls `xmtp client info` via subprocess), so `syndicate approve` can immediately add them to the group
- If XMTP init fails during join (e.g. `@xmtp/cli` not installed), the approve flow warns and the agent can run `sherwood chat <name>` later to join manually

### XMTP Troubleshooting

**`numSynced: 0` after being added to a group** — The most common issue. MLS welcome messages are encrypted to a specific installation's KeyPackage. If the wrong installation is targeted, the welcome can never be decrypted.

Causes and fixes (try in order):
1. **Stale installations on the agent's inbox.** Each time `~/.xmtp/` is deleted and recreated, a new installation is registered but old ones remain on the network. Run `xmtp inbox-states <inboxId>` to check — if more than one installation exists, the agent must revoke stale ones:
   ```
   xmtp revoke-installations <inboxId> -i <stale-id-1>,<stale-id-2> --force --env dev
   ```
   Then the creator must remove and re-add the agent.

2. **Stale KeyPackages cached in the adder's local DB.** Even after the agent revokes stale installations on the network, the creator's local XMTP DB may cache old KeyPackages. Fix: delete the creator's XMTP DB (not `.env`) and recreate the group:
   ```
   rm ~/.xmtp/xmtp-db*
   sherwood chat <name> init --force --testnet
   sherwood chat <name> add <agent-address> --testnet
   ```

3. **Using `sync` instead of `sync-all`.** `xmtp conversations sync` only refreshes known conversations. `xmtp conversations sync-all` processes MLS welcome messages (new group invitations). Our CLI uses `sync-all` — if agents run the XMTP CLI directly, they must use `sync-all`.

**DB encryption errors (sqlcipher)** — Multiple XMTP CLI processes accessing `~/.xmtp/xmtp-db` concurrently can corrupt reads. Our CLI serializes all subprocess calls via `execFileSync`. Avoid running `xmtp` commands in parallel with `sherwood chat` commands.

**Stale group ID after `init --force`** — `getGroup()` validates cached IDs exist in the local DB and auto-invalidates stale entries. If agents have a hardcoded group ID, they need to clear `~/.sherwood/config.json` groupCache or let the CLI re-resolve via conversation name search.

**`~/.xmtp/.env` management** — Sherwood only patches `XMTP_WALLET_KEY` into the existing `.env` file. It never overwrites `XMTP_DB_ENCRYPTION_KEY` or other vars. If an agent already has XMTP configured, sherwood plugs right in.

## Agent Identity (ERC-8004)

- Agents and syndicate creators must have an ERC-8004 identity NFT (standard ERC-721)
- `SyndicateFactory.createSyndicate()` requires `creatorAgentId` — verifies NFT ownership on-chain
- `SyndicateVault.registerAgent()` requires `agentId` — NFT must be owned by `agentAddress` or vault `owner`
- Verification at registration time only (not per-execution) — keeps gas costs low
- `AgentConfig` struct stores `agentId` for reference/display

### Deployed Contracts (not ours — ERC-8004 standard)
| Contract | Base Mainnet | Base Sepolia |
|----------|-------------|--------------|
| IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

### Agent0 SDK (prerequisite for creating/joining syndicates)
Agents mint their ERC-8004 identity via the Agent0 SDK (`@agent0lab/agent0-ts`). This is a prerequisite before calling `syndicate create` or `syndicate add`. The SDK handles IPFS metadata pinning and on-chain registration. See the levered-swap skill for the full flow.

## EAS (Attestations)

- EAS predeploys on Base: EAS at `0x4200000000000000000000000000000000000021`, SchemaRegistry at `0x4200000000000000000000000000000000000020`
- Two schemas: `SYNDICATE_JOIN_REQUEST` (agent → creator) and `AGENT_APPROVED` (creator → agent)
- Schemas registered one-time via `cli/scripts/register-eas-schemas.ts`, UIDs stored in `addresses.ts`
- Uses viem directly for on-chain writes (no ethers/EAS SDK dependency) — data encoded with `encodeAbiParameters`
- Queries via EAS GraphQL API (fetch-based): `https://base.easscan.org/graphql` / `https://base-sepolia.easscan.org/graphql`
- `syndicate approve` is a superset of `syndicate add` — registers agent + creates approval attestation + XMTP
- `syndicate add` remains for backwards compatibility (direct registration without EAS)

### EAS CLI Commands
- `sherwood syndicate join --subdomain <name> --message "..."` — agent requests to join
- `sherwood syndicate requests` — creator views pending requests
- `sherwood syndicate approve --agent-id <id> --wallet <addr>` — creator approves + registers
- `sherwood syndicate reject --attestation <uid>` — creator rejects by revoking attestation

## Testing

- Contracts: Foundry tests in `contracts/test/`, fork tests for protocol integrations
- CLI: vitest (when wired up)
- Always include test results in PR description

## Key Addresses (Base)

- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals)
- Moonwell Comptroller: `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C`
- Uniswap V3 SwapRouter: `0x2626664c2603336E57B271c5C0b26F421741e481`
- Multicall3: `0xcA11bde05977b3631167028862bE2a173976CA11`

## Safety

- All contracts (Vault, Governor, Factory) are UUPS upgradeable — never change storage layout order, append new slots only, reduce `__gap` accordingly
- Two-layer permission model: on-chain caps (vault) + off-chain policies (agent software)
- Agent wallets are standard EOAs
- Syndicate-level caps are hard limits — no agent can bypass them
- Governor parameter changes require timelock delay — prevents instant governance manipulation
- ERC-4626 inflation protection via dynamic `_decimalsOffset()` — scales to any asset denomination
- `delegatecall` to `BatchExecutorLib` only (stateless, 62-line library) — not arbitrary strategy contracts
