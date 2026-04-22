/**
 * Deterministic XMTP/Telegram summary formatter.
 *
 * `sherwood agent summary` pipes this output directly to chat send --stdin.
 * No LLM interpretation — the format is code, not a prompt.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CycleResult } from "./loop.js";
import type { PortfolioState } from "./risk.js";
import type { TradeRecord } from "./portfolio.js";

// ── Ticker mapping (CoinGecko ID → short symbol) ──

const TICKER: Record<string, string> = {
  bitcoin: "BTC", ethereum: "ETH", solana: "SOL", hyperliquid: "HYPE",
  ethena: "ENA", aave: "AAVE", dogecoin: "DOGE", near: "NEAR",
  ripple: "XRP", sui: "SUI", fartcoin: "FARTCOIN", bittensor: "TAO",
  zcash: "ZEC", arbitrum: "ARB", "avalanche-2": "AVAX", chainlink: "LINK",
  "worldcoin-wld": "WLD", "pudgy-penguins": "PENGU", binancecoin: "BNB",
  blur: "BLUR", "fetch-ai": "FET", cardano: "ADA",
};

function ticker(cgId: string): string {
  return TICKER[cgId] ?? cgId.slice(0, 6).toUpperCase();
}

// ── Formatting helpers ──

function fmtUsd(v: number): string {
  const sign = v >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
}

function fmtPrice(p: number): string {
  return p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
}

function arrow(action: string): string {
  if (action.includes("BUY")) return "\u25B2";   // ▲
  if (action.includes("SELL")) return "\u25BC";   // ▼
  return "\u2014\u2014";                           // ——
}

// ── Main formatter ──

export interface GridSummaryStats {
  totalPnlUsd: number;
  todayPnlUsd: number;
  todayFills: number;
  totalRoundTrips: number;
  allocation: number;
  paused: boolean;
}

export interface SummaryInput {
  cycle: CycleResult;
  portfolio: PortfolioState;
  /** Most recent closed trades (last 3, for exit callouts). */
  recentTrades: TradeRecord[];
  /** All closed trades — used to compute total realized PnL. */
  allTrades: TradeRecord[];
  /** Cumulative grid stats from grid-portfolio.json (optional — omitted if grid disabled). */
  gridStats?: GridSummaryStats;
}

export function formatSummary(input: SummaryInput): string {
  const { cycle, portfolio } = input;
  const lines: string[] = [];

  const hasEntries = cycle.tradesExecuted > 0;
  const hasExits = cycle.exitsProcessed > 0;

  // Header
  if (hasEntries) {
    lines.push("\uD83E\uDD16 SHERWOOD \u2014 Trade Executed");
  } else if (hasExits) {
    lines.push("\uD83E\uDD16 SHERWOOD \u2014 Position Closed");
  } else {
    lines.push("\uD83E\uDD16 SHERWOOD \u2014 Scan Complete");
  }
  lines.push("\u2501".repeat(28));

  // Entry callout — show open positions that were just opened this cycle
  if (hasEntries) {
    for (const pos of portfolio.positions) {
      // Heuristic: position opened in the last 2 minutes = this cycle
      const age = Date.now() - (pos.entryTimestamp ?? 0);
      if (age > 120_000) continue;
      const side = (pos.side ?? "long").toUpperCase();
      const stopPct = Math.abs(pos.entryPrice - pos.stopLoss) / pos.entryPrice;
      const tpPct = Math.abs(pos.takeProfit - pos.entryPrice) / pos.entryPrice;
      const sizeUsd = pos.quantity * pos.entryPrice;
      const portPct = portfolio.totalValue > 0 ? (sizeUsd / portfolio.totalValue) * 100 : 0;
      lines.push("");
      lines.push(`\uD83C\uDFAF ${side} ${ticker(pos.tokenId)} @ ${fmtPrice(pos.entryPrice)}`);
      lines.push(`   Stop ${fmtPrice(pos.stopLoss)} (${fmtPct(-stopPct)}) | TP ${fmtPrice(pos.takeProfit)} (${fmtPct(tpPct)})`);
      lines.push(`   Size $${sizeUsd.toFixed(0)} (${portPct.toFixed(1)}% of port)`);
    }
  }

  // Exit callout — show trades closed this cycle
  if (hasExits) {
    // Find trades with exitTimestamp in the last 2 minutes
    const now = Date.now();
    const recentExits = input.recentTrades.filter(t => now - (t.exitTimestamp ?? 0) < 120_000);
    for (const t of recentExits.slice(0, 3)) {
      const pctMove = t.pnlPercent;
      const reason = t.exitReason.replace(/\s*\(price:.*\)/, ""); // strip raw price
      lines.push("");
      lines.push(`\u2705 CLOSED ${ticker(t.tokenId)} ${t.side}`);
      lines.push(`   ${fmtPrice(t.entryPrice)} \u2192 ${fmtPrice(t.exitPrice)} (${fmtPct(pctMove)})`);
      lines.push(`   P&L: ${fmtUsd(t.pnlUsd)} | ${reason}`);
    }
  }

  // Regime
  const regime = cycle.signals.find(s => s.regime)?.regime ?? "unknown";
  lines.push("");
  lines.push(`\uD83D\uDCCA Regime: ${regime.charAt(0).toUpperCase() + regime.slice(1)}`);

  // Portfolio — show realized vs unrealized separately so the headline
  // number doesn't mislead. The old format showed totalPnlPct which mixes
  // mark-to-market unrealized swings with actual closed-trade P&L.
  const realizedPnl = input.allTrades.reduce((sum, t) => sum + t.pnlUsd, 0);
  const unrealized = cycle.unrealizedPnl;
  const initVal = portfolio.initialValue ?? 10_000;
  const realizedPct = initVal > 0 ? realizedPnl / initVal : 0;
  const cashPct = initVal > 0 ? (portfolio.cash / initVal) * 100 : 0;
  const positionValue = cycle.portfolioValue - portfolio.cash;

  lines.push("");
  lines.push(`\uD83D\uDCB0 $${cycle.portfolioValue.toFixed(2)}`);
  lines.push(`   Total Realized: ${fmtUsd(realizedPnl)} (${fmtPct(realizedPct)}) from ${input.allTrades.length} trades`);
  lines.push(`   Open P&L: ${fmtUsd(unrealized)} | Cash: $${portfolio.cash.toFixed(0)} | Positions: $${positionValue.toFixed(0)}`);
  lines.push(`   Today: ${fmtUsd(cycle.dailyRealizedPnl)} realized | ${fmtUsd(unrealized)} open`);

  // Grid stats — always show cumulative if grid is active
  const gf = cycle.gridFills ?? 0;
  const gs = input.gridStats;
  if (gs && !gs.paused) {
    const todayStr = gs.todayFills > 0
      ? `${gs.todayFills} fills ${fmtUsd(gs.todayPnlUsd)} today`
      : "no fills today";
    lines.push(`   Grid: ${fmtUsd(gs.totalPnlUsd)} total (${gs.totalRoundTrips} trips) | ${todayStr} | $${gs.allocation.toFixed(0)} alloc`);
  } else if (gs?.paused) {
    lines.push(`   Grid: PAUSED`);
  }

  // Signals — top 4 by |score|, always include any BUY/SELL
  const sorted = [...cycle.signals].sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const actionable = sorted.filter(s => s.action !== "HOLD");
  const topHolds = sorted.filter(s => s.action === "HOLD").slice(0, 4 - actionable.length);
  const display = [...actionable, ...topHolds].slice(0, 5);

  lines.push("");
  lines.push(`\uD83D\uDD0E Signals (${cycle.tokensAnalyzed} scanned):`);
  for (const s of display) {
    const t = ticker(s.token).padEnd(10);
    const sc = (s.score >= 0 ? "+" : "") + s.score.toFixed(3);
    lines.push(`   ${t} ${sc}  ${arrow(s.action)}`);
  }

  // Footer
  lines.push("");
  const parts: string[] = [];
  if (hasEntries || hasExits) {
    parts.push(`${cycle.tradesExecuted} entr${cycle.tradesExecuted === 1 ? "y" : "ies"} | ${cycle.exitsProcessed} exit${cycle.exitsProcessed === 1 ? "" : "s"}`);
  }
  if (gf > 0) {
    parts.push(`Grid: ${gf} fills`);
  }
  if (parts.length === 0) {
    lines.push("\u26A1 No entries. No exits. Watching.");
  } else {
    lines.push(`\u26A1 ${parts.join(" | ")}`);
  }

  return lines.join("\n");
}

// ── CLI entry point ──

export async function printSummary(): Promise<void> {
  const base = join(homedir(), ".sherwood", "agent");

  // Read latest cycle
  const cyclesRaw = await readFile(join(base, "cycles.jsonl"), "utf-8");
  const cycleLines = cyclesRaw.trim().split("\n").filter(Boolean);
  if (cycleLines.length === 0) {
    console.error("No cycles found in cycles.jsonl");
    process.exitCode = 1;
    return;
  }
  const cycle = JSON.parse(cycleLines[cycleLines.length - 1]!) as CycleResult;

  // Read portfolio
  let portfolio: PortfolioState;
  try {
    portfolio = JSON.parse(await readFile(join(base, "portfolio.json"), "utf-8")) as PortfolioState;
  } catch {
    portfolio = { totalValue: 0, positions: [], cash: 0, dailyPnl: 0, weeklyPnl: 0, monthlyPnl: 0 };
  }

  // Read recent trades
  let trades: TradeRecord[] = [];
  try {
    trades = JSON.parse(await readFile(join(base, "trades.json"), "utf-8")) as TradeRecord[];
  } catch {
    // No trades file
  }

  // Read grid stats (optional — absent if grid never initialized)
  let gridStats: GridSummaryStats | undefined;
  try {
    const gridRaw = JSON.parse(await readFile(join(base, "grid-portfolio.json"), "utf-8"));
    const grids = gridRaw.grids as Array<{ allocation: number; stats: { totalPnlUsd: number; todayPnlUsd: number; todayFills: number; totalRoundTrips: number } }>;
    gridStats = {
      totalPnlUsd: grids.reduce((s, g) => s + g.stats.totalPnlUsd, 0),
      todayPnlUsd: grids.reduce((s, g) => s + g.stats.todayPnlUsd, 0),
      todayFills: grids.reduce((s, g) => s + g.stats.todayFills, 0),
      totalRoundTrips: grids.reduce((s, g) => s + g.stats.totalRoundTrips, 0),
      allocation: grids.reduce((s, g) => s + g.allocation, 0),
      paused: gridRaw.paused ?? false,
    };
  } catch {
    // Grid not initialized — omit from summary
  }

  const msg = formatSummary({ cycle, portfolio, recentTrades: trades.slice(-5), allTrades: trades, gridStats });
  process.stdout.write(msg + "\n");
}
