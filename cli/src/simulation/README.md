# Sherwood Multi-Agent Simulation

A simulation toolkit for orchestrating 12 agents through the full Sherwood lifecycle: identity minting, syndicate creation, membership, deposits, XMTP chat, proposals, and voting.

Designed to be orchestrated by Claude Code — each phase is a CLI command, all state is persisted to JSON, and all operations are idempotent.

## Architecture

**Wallet derivation**: Single BIP-39 mnemonic → HD wallets via BIP-44 (`m/44'/60'/0'/0/i`).
- Index 0 = master wallet (holds ETH + USDC for funding)
- Indices 1-5 = creator agents (deploy syndicates)
- Indices 6-12 = joiner agents (request + join syndicates)

**XMTP/config isolation**: Each agent gets `HOME=/tmp/sherwood-sim/agents/agent-{i}` with its own `~/.sherwood/config.json` and `~/.xmtp/` database. Set per subprocess — no CLI modifications needed.

**State**: All progress is saved to `SIM_STATE_FILE` (default `/tmp/sherwood-sim/state.json`) after each operation. Every phase is idempotent — re-running skips completed steps.

## Setup

### Prerequisites

1. Node.js v20+
2. Install CLI dependencies: `cd cli && npm install`
3. A funded master wallet (holds ETH + USDC for all 12 agents)
4. A Base mainnet RPC URL

### Environment Variables

```bash
# Required
export SIM_MNEMONIC="word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12"
export BASE_RPC_URL="https://mainnet.base.org"

# Optional
export SIM_AGENT_COUNT=12          # default: 12
export SIM_SYNDICATE_COUNT=5       # default: 5
export SIM_DRY_RUN=false           # default: false (set true to skip on-chain calls)
export SIM_BASE_DIR=/tmp/sherwood-sim/agents   # default
export SIM_STATE_FILE=/tmp/sherwood-sim/state.json  # default
export SIM_FUND_ETH=0.002          # ETH per agent, default: 0.002
export SIM_FUND_USDC=50            # USDC per agent, default: 50
```

### Pre-flight check

Estimate total funding needed:
- ETH: `0.002 × 12 = 0.024 ETH` + gas buffer (~0.01 ETH)
- USDC: `50 × 12 = 600 USDC`

Index 0 wallet (master) must hold this before running Phase 01.

## Usage

### Full simulation (phases 01-08)

```bash
npx tsx cli/src/simulation/orchestrator.ts run-all
```

This runs all setup phases sequentially. Takes ~30-60 minutes depending on block times and RPC latency.

### Individual phases

```bash
# Phase 01 — Derive wallets, fund agents, mint ERC-8004 identities
npx tsx cli/src/simulation/orchestrator.ts setup

# Phase 02 — Creators deploy 5 syndicates (vault + ENS + XMTP group)
npx tsx cli/src/simulation/orchestrator.ts syndicates

# Phase 03 — Joiners send EAS membership requests
npx tsx cli/src/simulation/orchestrator.ts join

# Phase 04 — Creators approve pending requests (registers agent + adds to chat)
npx tsx cli/src/simulation/orchestrator.ts approve

# Phase 05 — All eligible agents deposit USDC into vaults
npx tsx cli/src/simulation/orchestrator.ts deposit

# Phase 06 — Agents send XMTP messages themed to their persona
npx tsx cli/src/simulation/orchestrator.ts chat

# Phase 07 — Creators submit Moonwell supply strategy proposals
npx tsx cli/src/simulation/orchestrator.ts propose

# Phase 08 — Members vote on pending proposals
npx tsx cli/src/simulation/orchestrator.ts vote
```

### Ongoing activity

```bash
# Run 3 heartbeat rounds (check chat, vote pending proposals, consider new proposals)
npx tsx cli/src/simulation/orchestrator.ts heartbeat --rounds 3
```

### Autonomous scheduling

Run the heartbeat on a fixed interval — designed to be started once and left running:

```bash
# Run heartbeat every 30 minutes, 3 rounds per cycle
npx tsx cli/src/simulation/orchestrator.ts schedule --interval 30 --rounds 3

# Run for exactly 10 cycles then exit
npx tsx cli/src/simulation/orchestrator.ts schedule --interval 30 --rounds 3 --max-cycles 10
```

Claude Code can start this in the background, then periodically check the structured log to decide if intervention is needed.

### Inspecting logs (for Claude)

Every CLI command is logged as a JSONL entry to `SIM_LOG_FILE` (default `/tmp/sherwood-sim/sim.log`).

```bash
# Show last 50 entries (human-readable)
npx tsx cli/src/simulation/orchestrator.ts logs

# Show only errors
npx tsx cli/src/simulation/orchestrator.ts logs --errors

# Filter to a specific phase or agent
npx tsx cli/src/simulation/orchestrator.ts logs --phase 3 --agent 7

# Raw JSONL output (for piping to jq or other tools)
npx tsx cli/src/simulation/orchestrator.ts logs --raw --last 100
```

### Diagnose (machine-readable for Claude)

The `diagnose` command outputs a JSON report Claude can parse to determine what needs attention:

```bash
npx tsx cli/src/simulation/orchestrator.ts diagnose
```

Output includes:
- `errorCount` — total failures since logging started
- `errorsByPhase` — per-phase breakdown of command + error message
- `agentsWithErrors` — which agent indices have had failures
- `errorPatterns` — deduplicated first-line error messages
- `suggestions` — auto-generated `sim retry --phase N` commands to run
- `simState` — full current state snapshot

### Retrying failures

After checking `diagnose`, re-run a specific phase without disturbing completed agents:

```bash
# Re-run phase 3 (all phases are idempotent — skips agents already marked done)
npx tsx cli/src/simulation/orchestrator.ts retry --phase 3
```

### Status

```bash
npx tsx cli/src/simulation/orchestrator.ts status
```

## Claude Autonomous Workflow

The simulation is designed so Claude Code can orchestrate it end-to-end:

1. **Start the run**: `sim run-all` (or individual phases)
2. **Schedule ongoing activity**: `sim schedule --interval 30 &` (background)
3. **Check health periodically**: `sim diagnose` → parse JSON → decide action
4. **Fix failures**: `sim logs --errors` → identify root cause → `sim retry --phase N`
5. **Inspect specific agents**: `sim logs --agent 7 --last 20`

All state is in two files:
- `/tmp/sherwood-sim/state.json` — structured sim state (agents, syndicates, proposals)
- `/tmp/sherwood-sim/sim.log` — append-only JSONL audit log of every command

## Agent Personas

| Index | Name | Role | Syndicate |
|-------|------|------|-----------|
| 0 | Master | Funder | — |
| 1 | Yield Maximizer | Creator | steady-yield |
| 2 | LP Hunter | Creator | aero-alpha |
| 3 | Venice Oracle | Creator | venice-oracle |
| 4 | Basis Trader | Creator | eth-staking |
| 5 | Multi-Strategy | Creator | diversified-defi |
| 6 | DeFi Scout | Joiner | assigned round-robin |
| 7 | Risk Sentinel | Joiner | assigned round-robin |
| 8 | Alpha Seeker | Joiner | assigned round-robin |
| 9 | Stable Hand | Joiner | assigned round-robin |
| 10 | Whale Watcher | Joiner | assigned round-robin |
| 11 | Gas Optimizer | Joiner | assigned round-robin |
| 12 | Governance Hawk | Joiner | assigned round-robin |

## State File

State is persisted at `SIM_STATE_FILE` (default `/tmp/sherwood-sim/state.json`). Example:

```json
{
  "agents": [
    {
      "index": 1,
      "address": "0x...",
      "role": "creator",
      "persona": "Yield Maximizer",
      "agentId": 42,
      "syndicateSubdomain": "steady-yield",
      "syndicateVault": "0x...",
      "funded": true,
      "identityMinted": true,
      "syndicateCreated": true,
      "joinRequested": false,
      "approved": false,
      "deposited": true
    }
  ],
  "syndicates": [
    {
      "subdomain": "steady-yield",
      "name": "Steady Yield Fund",
      "creatorIndex": 1,
      "vault": "0x...",
      "members": [1, 7, 12],
      "proposals": [
        {
          "id": 1,
          "proposerIndex": 1,
          "strategy": "moonwell-supply",
          "state": "voted"
        }
      ]
    }
  ],
  "phase": 8,
  "lastRun": 1711234567890
}
```

## Dry Run

Set `SIM_DRY_RUN=true` to validate the orchestration flow without any on-chain transactions:

```bash
SIM_DRY_RUN=true SIM_MNEMONIC="test test test ..." BASE_RPC_URL="..." \
  npx tsx cli/src/simulation/orchestrator.ts run-all
```

## File Structure

```
cli/src/simulation/
├── README.md                    # This file
├── types.ts                     # AgentState, SimConfig, SimState, etc.
├── config.ts                    # Load SimConfig from env vars
├── wallets.ts                   # HD wallet derivation (BIP-44)
├── agent-home.ts                # Per-agent HOME dir + config.json management
├── fund-agents.ts               # ETH + USDC transfers from master wallet
├── exec.ts                      # Run sherwood CLI with HOME isolation
├── state.ts                     # Read/write SimState to JSON
├── personas.ts                  # 12 agent persona definitions
├── phases/
│   ├── 01-setup.ts              # Derive wallets, fund, mint identities
│   ├── 02-create-syndicates.ts  # 5 creators deploy syndicates
│   ├── 03-join-syndicates.ts    # Joiners request membership
│   ├── 04-approve-members.ts    # Creators approve pending requests
│   ├── 05-deposit.ts            # Everyone deposits USDC
│   ├── 06-chat.ts               # Agents send XMTP messages
│   ├── 07-propose.ts            # Creators submit proposals
│   ├── 08-vote.ts               # Members vote on proposals
│   └── 09-heartbeat.ts          # Ongoing monitoring loop
└── orchestrator.ts              # Main CLI entry point
```
