# Grid Strategy Separation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the grid strategy into a standalone `sherwood grid start` command with its own loop, state file, and systemd service — fully independent from the directional agent.

**Architecture:** Move grid files from `cli/src/agent/grid/` to `cli/src/grid/`, create a lightweight grid-only event loop that runs on 1-minute cycles, and register a new `sherwood grid` CLI command. Remove all grid code from the agent loop. State moves to `~/.sherwood/grid/portfolio.json`.

**Tech Stack:** TypeScript, Hyperliquid REST API, Commander CLI

---

## File Structure

### New files to create

```
cli/src/grid/                      # Standalone grid module
  loop.ts                          # Grid-only event loop (1-min cycles)
  index.ts                         # Re-exports

cli/src/commands/grid.ts           # CLI: sherwood grid start|status|stop
```

### Files to move (rename)

```
cli/src/agent/grid/grid-config.ts     → cli/src/grid/config.ts
cli/src/agent/grid/grid-manager.ts    → cli/src/grid/manager.ts
cli/src/agent/grid/grid-portfolio.ts  → cli/src/grid/portfolio.ts
cli/src/agent/grid/grid-manager.test.ts → cli/src/grid/manager.test.ts
```

### Files to modify

```
cli/src/grid/portfolio.ts          # Change GRID_STATE_PATH to ~/.sherwood/grid/portfolio.json
cli/src/grid/portfolio.ts          # Change initialize() to accept capital directly (no allocationPct)
cli/src/grid/manager.ts            # Update imports from new paths
cli/src/grid/manager.test.ts       # Update imports from new paths
cli/src/agent/loop.ts              # Remove ALL grid code (imports, init, tick, gridOnly)
cli/src/agent/summary-formatter.ts # Read grid stats from new path
cli/src/commands/agent.ts          # Remove --grid-only flag
cli/src/index.ts                   # Register new grid command
```

### Files to delete

```
cli/src/agent/grid/                # Entire directory (moved to cli/src/grid/)
```

### Systemd

```
~/.config/systemd/user/sherwood-grid.service    # New service
~/.config/systemd/user/sherwood-agent.service   # Remove --grid-only flag
```

---

### Task 1: Move grid files to `cli/src/grid/`

**Files:**
- Move: `cli/src/agent/grid/grid-config.ts` → `cli/src/grid/config.ts`
- Move: `cli/src/agent/grid/grid-manager.ts` → `cli/src/grid/manager.ts`
- Move: `cli/src/agent/grid/grid-portfolio.ts` → `cli/src/grid/portfolio.ts`
- Move: `cli/src/agent/grid/grid-manager.test.ts` → `cli/src/grid/manager.test.ts`

- [ ] **Step 1: Create the new directory and copy files**

```bash
mkdir -p cli/src/grid
cp cli/src/agent/grid/grid-config.ts cli/src/grid/config.ts
cp cli/src/agent/grid/grid-manager.ts cli/src/grid/manager.ts
cp cli/src/agent/grid/grid-portfolio.ts cli/src/grid/portfolio.ts
cp cli/src/agent/grid/grid-manager.test.ts cli/src/grid/manager.test.ts
```

- [ ] **Step 2: Update imports in `cli/src/grid/manager.ts`**

Replace:
```typescript
import type { GridTokenState, GridLevel, GridFill, GridStats, GridConfig, GridPortfolioState } from './grid-config.js';
import { GridPortfolio } from './grid-portfolio.js';
```
With:
```typescript
import type { GridTokenState, GridLevel, GridFill, GridStats, GridConfig, GridPortfolioState } from './config.js';
import { GridPortfolio } from './portfolio.js';
```

Also update the Hyperliquid import — it's now one level up from the old location:
```typescript
// Old: import { HyperliquidProvider } from '../../providers/data/hyperliquid.js';
// New: import { HyperliquidProvider } from '../providers/data/hyperliquid.js';
```

Same for technical.ts import:
```typescript
// Old: import { getLatestSignals } from '../technical.js';
// New: import { getLatestSignals } from '../agent/technical.js';
```

- [ ] **Step 3: Update imports in `cli/src/grid/manager.test.ts`**

Replace:
```typescript
import type { GridTokenState, GridStats, GridLevel } from './grid-config.js';
import { DEFAULT_GRID_CONFIG } from './grid-config.js';
```
With:
```typescript
import type { GridTokenState, GridStats, GridLevel } from './config.js';
import { DEFAULT_GRID_CONFIG } from './config.js';
```

- [ ] **Step 4: Update state path in `cli/src/grid/portfolio.ts`**

Change line 13:
```typescript
// Old:
const GRID_STATE_PATH = join(homedir(), '.sherwood', 'agent', 'grid-portfolio.json');
// New:
const GRID_STATE_PATH = join(homedir(), '.sherwood', 'grid', 'portfolio.json');
```

- [ ] **Step 5: Update `initialize()` in `cli/src/grid/portfolio.ts` to accept capital directly**

Change the method signature from:
```typescript
async initialize(totalPortfolioValue: number, config: GridConfig): Promise<number> {
    const allocation = totalPortfolioValue * config.allocationPct;
```
To:
```typescript
async initialize(capital: number, config: GridConfig): Promise<void> {
    const allocation = capital;  // Direct capital amount, no percentage
```

And change the return type — no longer returns a number (nothing to "carve" from):
```typescript
    await this.save(state);
    this.state = state;
    // Old: return allocation;
    // New: no return needed
```

- [ ] **Step 6: Run tests**

```bash
cd cli && npx vitest run src/grid/manager.test.ts
```

Expected: All tests pass (imports updated, logic unchanged).

- [ ] **Step 7: Commit**

```bash
git add cli/src/grid/
git commit -m "refactor: move grid strategy to cli/src/grid/ (standalone module)"
```

---

### Task 2: Create the grid-only event loop (`cli/src/grid/loop.ts`)

**Files:**
- Create: `cli/src/grid/loop.ts`
- Create: `cli/src/grid/index.ts`

- [ ] **Step 1: Create `cli/src/grid/index.ts`**

```typescript
export { GridManager } from './manager.js';
export type { GridTickResult } from './manager.js';
export { DEFAULT_GRID_CONFIG } from './config.js';
export type { GridConfig } from './config.js';
export { GridPortfolio } from './portfolio.js';
```

- [ ] **Step 2: Create `cli/src/grid/loop.ts`**

```typescript
/**
 * Standalone grid event loop — runs independently from the directional agent.
 * Fetches prices from Hyperliquid and ticks the grid manager every cycle.
 */

import chalk from 'chalk';
import { GridManager } from './manager.js';
import { GridPortfolio } from './portfolio.js';
import { DEFAULT_GRID_CONFIG } from './config.js';
import type { GridConfig } from './config.js';
import { HyperliquidProvider } from '../providers/data/hyperliquid.js';

export interface GridLoopConfig {
  capital: number;           // Initial capital in USD
  cycle: number;             // Cycle interval in milliseconds
  config?: Partial<GridConfig>;
}

export class GridLoop {
  private running = false;
  private cycleCount = 0;
  private config: GridLoopConfig;
  private gridConfig: GridConfig;
  private manager: GridManager;
  private portfolio: GridPortfolio;
  private hl: HyperliquidProvider;

  constructor(config: GridLoopConfig) {
    this.config = config;
    this.gridConfig = { ...DEFAULT_GRID_CONFIG, ...config.config };
    this.manager = new GridManager(this.gridConfig);
    this.portfolio = new GridPortfolio();
    this.hl = new HyperliquidProvider();
  }

  async start(): Promise<void> {
    this.running = true;

    // Initialize grid if not already persisted
    const existing = await this.portfolio.load();
    if (!existing) {
      await this.portfolio.initialize(this.config.capital, this.gridConfig);
      console.log(chalk.green(`  Grid initialized: $${this.config.capital.toFixed(0)} across ${this.gridConfig.tokens.join(', ')}`));
    } else {
      console.log(chalk.dim(`  Grid loaded: ${existing.grids.length} tokens, $${existing.totalAllocation.toFixed(0)} allocated`));
    }

    // Sync new tokens added to config
    await this.manager.init(this.config.capital);

    // Startup banner
    console.log(chalk.bold('\n  Sherwood Grid Strategy'));
    console.log(chalk.dim('  ' + '─'.repeat(40)));
    console.log(`  Tokens:   ${this.gridConfig.tokens.join(', ')}`);
    console.log(`  Capital:  $${this.config.capital.toFixed(0)}`);
    console.log(`  Leverage: ${this.gridConfig.leverage}x`);
    console.log(`  Levels:   ${this.gridConfig.levelsPerSide} per side`);
    console.log(`  Cycle:    ${this.config.cycle / 1000}s`);
    console.log('  Press Ctrl+C to stop.\n');

    // Graceful shutdown
    const shutdown = () => {
      console.log(chalk.dim('\n  Shutting down grid...'));
      this.running = false;
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Main loop
    while (this.running) {
      try {
        await this.runCycle();
      } catch (err) {
        console.error(chalk.red(`  Grid cycle error: ${(err as Error).message}`));
      }

      if (this.running) {
        await new Promise(resolve => setTimeout(resolve, this.config.cycle));
      }
    }

    console.log(chalk.dim('  Grid stopped.'));
  }

  private async runCycle(): Promise<void> {
    this.cycleCount++;

    // Fetch prices for all grid tokens
    const prices: Record<string, number> = {};
    for (const token of this.gridConfig.tokens) {
      try {
        const data = await this.hl.getHyperliquidData(token);
        if (data?.markPrice && data.markPrice > 0) {
          prices[token] = data.markPrice;
        }
      } catch {
        // Skip token this cycle
      }
    }

    if (Object.keys(prices).length === 0) return;

    // Tick the grid
    const result = await this.manager.tick(prices);

    // Log round trips
    if (result.fills > 0 || this.cycleCount % 60 === 0) {
      const state = await this.portfolio.load();
      const totalPnl = state
        ? state.grids.reduce((s, g) => s + g.stats.totalPnlUsd, 0)
        : 0;
      const totalRts = state
        ? state.grids.reduce((s, g) => s + g.stats.totalRoundTrips, 0)
        : 0;

      if (result.fills > 0) {
        console.log(
          chalk.green(`  [grid] +${result.fills} fills, ${result.roundTrips} RTs, ` +
            `$${result.pnlUsd.toFixed(2)} this tick | ` +
            `Total: ${totalRts} RTs, $${totalPnl.toFixed(2)} PnL`)
        );
      } else {
        // Periodic status (every ~60 cycles = 1 hour at 1-min cycles)
        console.log(
          chalk.dim(`  [grid] Status: ${totalRts} RTs, $${totalPnl.toFixed(2)} PnL, ` +
            `${Object.keys(prices).length} tokens priced`)
        );
      }
    }
  }
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd cli && npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add cli/src/grid/loop.ts cli/src/grid/index.ts
git commit -m "feat: add standalone grid event loop (1-min cycles, no signal analysis)"
```

---

### Task 3: Create `sherwood grid` CLI command

**Files:**
- Create: `cli/src/commands/grid.ts`
- Modify: `cli/src/index.ts` — register the grid command

- [ ] **Step 1: Create `cli/src/commands/grid.ts`**

```typescript
/**
 * CLI command: sherwood grid start|status
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { GridLoop } from '../grid/loop.js';
import { GridPortfolio } from '../grid/portfolio.js';
import { DEFAULT_GRID_CONFIG } from '../grid/config.js';

export function registerGridCommand(program: Command): void {
  const grid = program
    .command('grid')
    .description('Standalone grid trading strategy');

  grid
    .command('start')
    .description('Start the grid strategy')
    .option('--capital <usd>', 'Initial capital in USD', '5000')
    .option('--cycle <seconds>', 'Cycle interval in seconds', '60')
    .option('--tokens <list>', 'Comma-separated token list', 'bitcoin,ethereum,solana')
    .option('--leverage <n>', 'Leverage multiplier', '5')
    .option('--levels <n>', 'Levels per side', '15')
    .action(async (options: { capital: string; cycle: string; tokens: string; leverage: string; levels: string }) => {
      const capital = parseFloat(options.capital);
      const cycleMs = parseInt(options.cycle) * 1000;
      const tokens = options.tokens.split(',').map(t => t.trim());
      const leverage = parseInt(options.leverage);
      const levels = parseInt(options.levels);

      // Build token split (equal weight)
      const split: Record<string, number> = {};
      for (const t of tokens) {
        split[t] = 1 / tokens.length;
      }

      const loop = new GridLoop({
        capital,
        cycle: cycleMs,
        config: {
          tokens,
          leverage,
          levelsPerSide: levels,
          tokenSplit: split,
        },
      });

      await loop.start();
    });

  grid
    .command('status')
    .description('Show current grid state and performance')
    .action(async () => {
      const portfolio = new GridPortfolio();
      const state = await portfolio.load();

      if (!state) {
        console.log(chalk.yellow('No grid state found. Run "sherwood grid start" first.'));
        return;
      }

      console.log(chalk.bold('\n  Grid Status'));
      console.log(chalk.dim('  ' + '─'.repeat(50)));
      console.log(`  Allocation: $${state.totalAllocation.toFixed(2)}`);
      console.log(`  Paused: ${state.paused ? chalk.red('YES — ' + state.pauseReason) : chalk.green('NO')}`);
      console.log();

      let totalPnl = 0;
      let totalRts = 0;
      for (const g of state.grids) {
        const s = g.stats;
        totalPnl += s.totalPnlUsd;
        totalRts += s.totalRoundTrips;
        console.log(`  ${g.token.toUpperCase().padEnd(12)} RTs: ${s.totalRoundTrips.toString().padStart(4)}  PnL: $${s.totalPnlUsd.toFixed(2).padStart(10)}  Today: $${s.todayPnlUsd.toFixed(2).padStart(8)}  Fills: ${s.todayFills}`);
      }
      console.log(chalk.dim('  ' + '─'.repeat(50)));
      console.log(`  ${'TOTAL'.padEnd(12)} RTs: ${totalRts.toString().padStart(4)}  PnL: $${totalPnl.toFixed(2).padStart(10)}`);
      console.log();
    });
}
```

- [ ] **Step 2: Register the grid command in `cli/src/index.ts`**

Add import at the top:
```typescript
import { registerGridCommand } from './commands/grid.js';
```

Add registration after the existing command registrations:
```typescript
registerGridCommand(program);
```

- [ ] **Step 3: Run typecheck + build**

```bash
cd cli && npm run typecheck && npm run build
```

- [ ] **Step 4: Test the CLI**

```bash
sherwood grid --help
sherwood grid status
```

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/grid.ts cli/src/index.ts
git commit -m "feat: add 'sherwood grid start|status' CLI command"
```

---

### Task 4: Remove grid code from agent loop

**Files:**
- Modify: `cli/src/agent/loop.ts` — remove all grid imports, init, tick, gridOnly
- Modify: `cli/src/commands/agent.ts` — remove `--grid-only` flag

- [ ] **Step 1: Clean `cli/src/agent/loop.ts`**

Remove these imports (lines 20-22):
```typescript
import { GridManager } from './grid/grid-manager.js';
import type { GridTickResult } from './grid/grid-manager.js';
import { DEFAULT_GRID_CONFIG } from './grid/grid-config.js';
```

Remove from `LoopConfig` interface:
```typescript
  gridOnly?: boolean;
```

Remove from `CycleResult` interface:
```typescript
  gridFills: number;
  gridRoundTrips: number;
  gridPnlUsd: number;
```

Remove from class properties:
```typescript
  private gridManager: GridManager;
  private hlForGrid: HyperliquidProvider;
  private gridInitialized = false;
  private lastRegime: string | undefined;
```

Remove from constructor:
```typescript
    this.gridManager = new GridManager(DEFAULT_GRID_CONFIG);
    this.hlForGrid = new HyperliquidProvider();
```

Remove the grid init block in `start()` (lines ~123-136).

Remove the entire grid tick section in `runCycle()` (lines ~299-317) — the `gridResult` variable and grid price fetching.

Remove the `gridOnly` early-return block (lines ~319-345).

Remove `gridFills`, `gridRoundTrips`, `gridPnlUsd` from the CycleResult construction at the end of `runCycle()`.

Remove `lastRegime` updates.

- [ ] **Step 2: Clean `cli/src/commands/agent.ts`**

Remove the `--grid-only` option:
```typescript
    .option("--grid-only", "Run grid strategy only...")
```

Remove `gridOnly` from the options type and the loopConfig:
```typescript
    gridOnly: options.gridOnly ?? false,
```

- [ ] **Step 3: Run typecheck**

```bash
cd cli && npm run typecheck
```

Fix any remaining references to grid in the agent code.

- [ ] **Step 4: Run full test suite**

```bash
cd cli && npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add cli/src/agent/loop.ts cli/src/commands/agent.ts
git commit -m "refactor: remove all grid code from agent loop — grid is now standalone"
```

---

### Task 5: Delete old grid directory

**Files:**
- Delete: `cli/src/agent/grid/` (entire directory)

- [ ] **Step 1: Remove old grid directory**

```bash
rm -rf cli/src/agent/grid/
```

- [ ] **Step 2: Run typecheck to verify no dangling references**

```bash
cd cli && npm run typecheck
```

- [ ] **Step 3: Run tests**

```bash
cd cli && npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add -A cli/src/agent/grid/
git commit -m "chore: delete old cli/src/agent/grid/ — moved to cli/src/grid/"
```

---

### Task 6: Update summary formatter to read from new grid path

**Files:**
- Modify: `cli/src/agent/summary-formatter.ts`

- [ ] **Step 1: Update the grid stats reader in `printSummary()`**

The grid portfolio path changed. Update the reader:

```typescript
// Old:
const gridRaw = JSON.parse(await readFile(join(base, "grid-portfolio.json"), "utf-8"));
// New:
const gridBase = join(homedir(), ".sherwood", "grid");
const gridRaw = JSON.parse(await readFile(join(gridBase, "portfolio.json"), "utf-8"));
```

- [ ] **Step 2: Run typecheck + build**

```bash
cd cli && npm run typecheck && npm run build
```

- [ ] **Step 3: Test the summary**

```bash
sherwood agent summary
```

- [ ] **Step 4: Commit**

```bash
git add cli/src/agent/summary-formatter.ts
git commit -m "fix: summary reads grid stats from new path ~/.sherwood/grid/portfolio.json"
```

---

### Task 7: Migrate existing grid state + create systemd services

- [ ] **Step 1: Migrate existing grid state to new path**

```bash
mkdir -p ~/.sherwood/grid
cp ~/.sherwood/agent/grid-portfolio.json ~/.sherwood/grid/portfolio.json
```

- [ ] **Step 2: Create grid systemd service**

Create `~/.config/systemd/user/sherwood-grid.service`:

```ini
[Unit]
Description=Sherwood Grid Strategy — 1-min cycle grid trading
After=network.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
ExecStart=/home/ana/.linuxbrew/bin/sherwood grid start --capital 5000 --cycle 60
WorkingDirectory=/home/ana/code/sherwood/cli
Environment="HOME=/home/ana"
Environment="PATH=/home/ana/.linuxbrew/bin:/home/ana/.linuxbrew/sbin:/home/ana/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment="NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt"
Restart=on-failure
RestartSec=30
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

- [ ] **Step 3: Update agent service — remove `--grid-only`**

In `~/.config/systemd/user/sherwood-agent.service`, change:
```
ExecStart=/home/ana/.linuxbrew/bin/sherwood agent start --auto --cycle 5m --grid-only
```
To:
```
ExecStart=/home/ana/.linuxbrew/bin/sherwood agent start --auto --cycle 5m
```

- [ ] **Step 4: Build, reload, and start services**

```bash
cd cli && npm run build
systemctl --user daemon-reload
systemctl --user restart sherwood-agent
systemctl --user enable sherwood-grid
systemctl --user start sherwood-grid
```

- [ ] **Step 5: Verify both services running**

```bash
systemctl --user status sherwood-agent
systemctl --user status sherwood-grid
```

- [ ] **Step 6: Verify grid is producing fills**

```bash
journalctl --user -u sherwood-grid -n 10 --no-pager
sherwood grid status
```

- [ ] **Step 7: Commit**

```bash
git add cli/src/
git commit -m "feat: grid fully separated — own service, own state, 1-min cycles"
```

---

## Dependency Graph

```
Task 1 (move files)
  └─> Task 2 (grid loop)
        └─> Task 3 (CLI command)
              └─> Task 4 (remove from agent)
                    └─> Task 5 (delete old dir)
                          └─> Task 6 (update summary)
                                └─> Task 7 (systemd + migrate state)
```

All tasks are sequential — each depends on the previous.
