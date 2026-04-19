/**
 * Trade execution module — dry-run paper trading + live execution placeholder.
 */

import chalk from 'chalk';
import type { Address, Hex } from 'viem';
import { createWalletClient, http, encodeFunctionData, encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { TradeDecision } from './scoring.js';
import type { Position } from './risk.js';
import { RiskManager } from './risk.js';
import { PortfolioTracker } from './portfolio.js';
import { BASE_STRATEGY_ABI } from '../lib/abis.js';
import { hyperevm, hyperevmTestnet } from '../lib/network.js';
import { RiskGate, DEFAULT_RISK_GATE_CONFIG } from './risk-gate.js';
import type { RiskGateConfig, MarketData, RiskGateResult } from './risk-gate.js';

export interface ExecutionConfig {
  dryRun: boolean;
  mevProtection: boolean;
  maxGasPrice?: bigint;
  chain: string;
  /** Execution mode: 'dry-run' (default) or 'hyperliquid-perp' (live on-chain) */
  mode?: 'dry-run' | 'hyperliquid-perp';
  /** Strategy clone address on HyperEVM (required for hyperliquid-perp mode) */
  strategyClone?: Address;
  /** Proposer private key (read from SHERWOOD_PROPOSER_KEY env) */
  proposerPrivateKey?: Hex;
  /** HyperCore perp asset index (default 3 = ETH) */
  assetIndex?: number;
  /** Risk gate configuration */
  riskGateConfig?: Partial<RiskGateConfig>;
}

export interface OrderParams {
  tokenId: string;
  side: 'buy' | 'sell';
  amountUsd: number;
  maxSlippage: number;
  stopLoss: number;
  takeProfit: number;
}

/** Score-based position sizing multiplier. Higher-conviction entries get larger positions. */
function convictionMultiplier(score: number): number {
  const absScore = Math.abs(score);
  if (absScore >= 0.45) return 2.0;
  if (absScore >= 0.35) return 1.5;
  return 1.0;
}

export class TradeExecutor {
  private config: ExecutionConfig;
  private riskManager: RiskManager;
  private portfolio: PortfolioTracker;
  private riskGate: RiskGate;
  private lastAtr?: number;

  constructor(config: ExecutionConfig, riskManager: RiskManager, portfolio: PortfolioTracker) {
    this.config = config;
    this.riskManager = riskManager;
    this.portfolio = portfolio;
    this.riskGate = new RiskGate(config.riskGateConfig);
  }

  /** CoinGecko token ID → Hyperliquid perp asset index.
   *  Used by multi-asset execution to resolve which HL perp to trade
   *  when a signal fires. One strategy clone can trade any of these. */
  private static readonly TOKEN_TO_ASSET_INDEX: Record<string, number> = {
    bitcoin: 0,
    ethereum: 1,
    solana: 2,
    arbitrum: 4,
    dogecoin: 6,
    chainlink: 8,
    aave: 10,
    uniswap: 11,
    ripple: 23,
    polkadot: 28,
    avalanche: 35,
    hyperliquid: 131,
    zcash: 144,
    bittensor: 148,
    "worldcoin-wld": 265,
    fartcoin: 343,
    "fetch-ai": 373,
    pepe: 166,
    pendle: 249,
    sui: 116,
    near: 71,
    aptos: 83,
  };

  /** Resolve a CoinGecko token ID to its HL perp asset index. */
  static resolveAssetIndex(tokenId: string): number | undefined {
    return TradeExecutor.TOKEN_TO_ASSET_INDEX[tokenId];
  }

  /** Execute a trade based on a decision */
  async execute(
    decision: TradeDecision,
    tokenId: string,
    currentPrice: number,
    atr?: number,
    marketData?: MarketData,
    sellThreshold?: number,
  ): Promise<{
    success: boolean;
    position?: Position;
    error?: string;
    dryRun: boolean;
    riskGateResult?: RiskGateResult;
  }> {
    // Handle SELL/STRONG_SELL outside hyperliquid-perp mode.
    //   • If an existing LONG exists → close it (signal flip / take-profit-by-signal).
    //   • Otherwise (no position OR existing SHORT) → fall through to the
    //     standard open/pyramid path below, which opens a paper short or
    //     pyramids into the existing short. This was previously a hard error
    //     ("No open position to sell") — paper shorting was effectively dead
    //     code, masking SHORT signal performance in dry-run.
    if ((decision.action === 'SELL' || decision.action === 'STRONG_SELL') && this.config.mode !== 'hyperliquid-perp') {
      const sellState = await this.portfolio.load();
      const existing = sellState.positions.find((p) => p.tokenId === tokenId);
      const existingSide = existing?.side ?? 'long';

      if (existing && existingSide === 'long') {
        try {
          const reason = decision.action === 'STRONG_SELL' ? 'Strong sell signal' : 'Sell signal';
          if (this.config.dryRun) {
            console.error(chalk.cyan(`[DRY RUN] Paper trade: SELL ${existing.quantity.toFixed(6)} ${tokenId} @ $${currentPrice.toFixed(4)}`));
          }
          const closeResult = await this.portfolio.closePosition(tokenId, currentPrice, reason);
          return {
            success: true,
            position: { ...existing, currentPrice, pnlUsd: closeResult.pnl, pnlPercent: closeResult.pnlPercent },
            dryRun: this.config.dryRun,
          };
        } catch (err) {
          return {
            success: false,
            error: `Failed to close position: ${(err as Error).message}`,
            dryRun: this.config.dryRun,
          };
        }
      }
      // else: no existing long — fall through to open/pyramid a paper short
    }

    // Only execute buys/sells; HOLD does nothing
    if (decision.action !== 'BUY' && decision.action !== 'STRONG_BUY' && decision.action !== 'SELL' && decision.action !== 'STRONG_SELL') {
      return {
        success: false,
        error: `Action ${decision.action} does not trigger execution`,
        dryRun: this.config.dryRun,
      };
    }

    // Resolve token → HL asset index for multi-asset execution.
    // If the token doesn't have a known HL perp, skip execution.
    if (this.config.mode === 'hyperliquid-perp') {
      const resolvedIndex = TradeExecutor.resolveAssetIndex(tokenId);
      if (resolvedIndex === undefined) {
        return {
          success: false,
          error: `Token ${tokenId} has no known Hyperliquid perp asset index — skipping execution`,
          dryRun: this.config.dryRun,
        };
      }
    }

    // Load portfolio to get current state
    const state = await this.portfolio.load();
    this.riskManager.updatePortfolio(state);

    // Apply risk gate before execution
    const riskGateResult = this.riskGate.applyGate(
      tokenId,
      decision,
      state,
      marketData || {},
      sellThreshold
    );

    // If risk gate vetoed or downgraded the action
    if (riskGateResult.finalAction === 'HOLD') {
      if (this.config.dryRun) {
        console.error(chalk.yellow(`[RISK GATE] ${tokenId} vetoed: ${riskGateResult.reasons.join(', ')}`));
      }
      return {
        success: false,
        error: `Risk gate veto: ${riskGateResult.reasons.join(', ')}`,
        dryRun: this.config.dryRun,
        riskGateResult,
      };
    }

    // Use the gated action for execution
    const gatedDecision = riskGateResult.finalAction !== riskGateResult.originalAction
      ? { ...decision, action: riskGateResult.finalAction }
      : decision;

    // Log if action was modified
    if (riskGateResult.wasGated && this.config.dryRun) {
      console.error(chalk.cyan(`[RISK GATE] ${tokenId} downgraded: ${riskGateResult.originalAction} → ${riskGateResult.finalAction} (${riskGateResult.reasons.join(', ')})`));
    }

    // Calculate stop loss and take profit from current price.
    // Calibrated for SHORT-TERM trades (1-2 day hold):
    //   Stop: 3% — tight enough that a failed trade exits quickly
    //   Take profit: 6% (2:1 R:R) — achievable in 1-2 days on crypto vol
    //   Time stop: 48h (see risk.ts) — if it hasn't moved, it's dead money
    const isShort = gatedDecision.action === 'SELL' || gatedDecision.action === 'STRONG_SELL';
    const direction: 'long' | 'short' = isShort ? 'short' : 'long';
    const RR_RATIO = 2.0;
    const ATR_STOP_MULTIPLIER = 1.5;
    const STOP_FLOOR = 0.02;   // minimum 2%
    const STOP_CAP = 0.10;     // maximum 10%
    const FALLBACK_STOP = 0.03; // when no ATR available

    const atrPct = (atr && currentPrice > 0 && !isNaN(atr))
      ? atr / currentPrice
      : FALLBACK_STOP / ATR_STOP_MULTIPLIER;
    const stopPct = Math.min(STOP_CAP, Math.max(STOP_FLOOR, atrPct * ATR_STOP_MULTIPLIER));
    this.lastAtr = atr;
    const stopLossDistance = currentPrice * stopPct;
    const stopLossPrice = isShort
      ? currentPrice + stopLossDistance      // stop above for shorts
      : currentPrice - stopLossDistance;     // stop below for longs
    const takeProfitPrice = isShort
      ? currentPrice * (1 - stopPct * RR_RATIO)    // profit below for shorts
      : currentPrice * (1 + stopPct * RR_RATIO);   // profit above for longs

    // Detect a pyramid (same-direction add to an existing position) and halve
    // the size for each add. Geometric decay (1.0x → 0.5x → 0.25x) caps total
    // exposure on a single name at 1.75x the original size.
    const existingSameSide = state.positions.find(
      (p) => p.tokenId === tokenId && (p.side ?? 'long') === direction,
    );
    const isPyramid = existingSameSide !== undefined;
    const sizeMultiplier = isPyramid
      ? 0.5 ** ((existingSameSide!.addCount ?? 0) + 1)
      : 1.0;

    // Size the position using risk management. Conviction is fed in via the
    // risk budget — the sizer then clamps at maxSinglePosition, so a
    // high-conviction entry cannot blow past the hard cap (previous bug:
    // sizing was clamped, then multiplied by conviction after, yielding 30%
    // sizes on score ≥ 0.35 and 40% on score ≥ 0.45 against a 20% cap).
    const conviction = convictionMultiplier(gatedDecision.score);
    const sizing = this.riskManager.calculatePositionSize(
      currentPrice,
      stopLossPrice,
      state.totalValue,
      this.riskManager.getRiskPerTrade() * conviction,
    );

    // Pyramid haircut shrinks size for each subsequent add (base 1.0x → 0.5x → 0.25x).
    const pyramidQuantity = sizing.quantity * sizeMultiplier;
    const pyramidSizeUsd = sizing.sizeUsd * sizeMultiplier;

    if (pyramidQuantity <= 0 || pyramidSizeUsd <= 0) {
      return {
        success: false,
        error: 'Position sizing returned zero — check portfolio value and stop distance',
        dryRun: this.config.dryRun,
      };
    }

    // Enforce Hyperliquid minimum notional ($15) AFTER the pyramid haircut.
    // calculatePositionSize() applies its own floor on the BASE size, but
    // halving (0.5x) and quartering (0.25x) for subsequent adds can push
    // the order below minimum. In dry-run this is harmless paper trading;
    // in hyperliquid-perp mode the order would revert at the venue.
    const MIN_PYRAMID_USD = 15;
    if (isPyramid && pyramidSizeUsd < MIN_PYRAMID_USD) {
      return {
        success: false,
        error: `Pyramid add #${(existingSameSide!.addCount ?? 0) + 1} would be $${pyramidSizeUsd.toFixed(2)} — below $${MIN_PYRAMID_USD} HL minimum notional. Skipping.`,
        dryRun: this.config.dryRun,
      };
    }

    // Check if risk manager allows this trade (passes pyramid + direction context)
    const check = this.riskManager.canOpenPosition(tokenId, pyramidSizeUsd, direction);
    if (!check.allowed) {
      return {
        success: false,
        error: `Risk check failed: ${check.reason}`,
        dryRun: this.config.dryRun,
      };
    }

    const order: OrderParams = {
      tokenId,
      side: isShort ? 'sell' : 'buy',
      amountUsd: pyramidSizeUsd,
      maxSlippage: 0.015,
      stopLoss: stopLossPrice,
      takeProfit: takeProfitPrice,
    };

    if (this.config.dryRun) {
      try {
        const position = await this.executeDryRun(order, currentPrice, isPyramid);
        return { success: true, position, dryRun: true, riskGateResult };
      } catch (err) {
        return {
          success: false,
          error: `Dry-run failed: ${(err as Error).message}`,
          dryRun: true,
          riskGateResult,
        };
      }
    } else {
      try {
        const result = await this.executeLive(order, currentPrice);
        // If live execution succeeded, also track in portfolio
        const position = isPyramid
          ? await this.portfolio.addToPosition(tokenId, result.executedPrice, pyramidQuantity, direction)
          : await this.portfolio.openPosition({
              tokenId,
              symbol: tokenId.toUpperCase(),
              side: direction,
              entryPrice: result.executedPrice,
              currentPrice: result.executedPrice,
              quantity: pyramidQuantity,
              entryTimestamp: Date.now(),
              stopLoss: order.stopLoss,
              takeProfit: order.takeProfit,
              strategy: gatedDecision.signals[0]?.source ?? 'agent',
              atrAtEntry: this.lastAtr,
            });
        return { success: true, position, dryRun: false, riskGateResult };
      } catch (err) {
        return {
          success: false,
          error: `Live execution failed: ${(err as Error).message}`,
          dryRun: false,
          riskGateResult,
        };
      }
    }
  }

  /** Process all pending exits (stops, take profits, time stops) */
  async processExits(
    currentPrices: Record<string, number>,
  ): Promise<Array<{ position: Position; exitPrice: number; reason: string; pnl: number }>> {
    const state = await this.portfolio.load();
    this.riskManager.updatePortfolio(state);

    const { toClose, reasons } = this.riskManager.checkExits(state.positions, currentPrices);
    const results: Array<{ position: Position; exitPrice: number; reason: string; pnl: number }> = [];

    for (const pos of toClose) {
      const exitPrice = currentPrices[pos.tokenId] ?? pos.currentPrice;
      const reason = reasons[pos.tokenId] ?? 'Unknown';

      try {
        const closeResult = await this.portfolio.closePosition(pos.tokenId, exitPrice, reason);
        results.push({
          position: pos,
          exitPrice,
          reason,
          pnl: closeResult.pnl,
        });
      } catch (err) {
        console.error(chalk.red(`Failed to close ${pos.symbol}: ${(err as Error).message}`));
      }
    }

    // --- Partial profit exits (50% at +3%) ---
    const PARTIAL_PROFIT_TRIGGER = 0.03; // +3% unrealized gain
    const PARTIAL_FRACTION = 0.5;

    const refreshedState = await this.portfolio.load();
    for (const pos of refreshedState.positions) {
      if (pos.partialTaken) continue; // already took partial
      const price = currentPrices[pos.tokenId];
      if (price === undefined) continue;

      const isShort = pos.side === 'short';
      const pnlPercent = isShort
        ? (pos.entryPrice - price) / (pos.entryPrice || 1)
        : (price - pos.entryPrice) / (pos.entryPrice || 1);

      if (pnlPercent >= PARTIAL_PROFIT_TRIGGER) {
        try {
          const partial = await this.portfolio.closePartial(
            pos.tokenId, PARTIAL_FRACTION, price, `Partial profit at ${(pnlPercent * 100).toFixed(1)}%`,
          );
          results.push({
            position: { ...pos, currentPrice: price },
            exitPrice: price,
            reason: `PARTIAL_PROFIT (${(pnlPercent * 100).toFixed(1)}%, closed ${(PARTIAL_FRACTION * 100).toFixed(0)}%)`,
            pnl: partial.pnl,
          });
          console.error(
            chalk.cyan(`  Partial exit: ${pos.symbol} ${(PARTIAL_FRACTION * 100).toFixed(0)}% @ $${price.toFixed(4)} — locked $${partial.pnl.toFixed(2)}`),
          );
        } catch (err) {
          console.error(chalk.red(`Failed partial close ${pos.symbol}: ${(err as Error).message}`));
        }
      }
    }

    return results;
  }

  /** Dry-run execution — paper trade */
  private async executeDryRun(order: OrderParams, currentPrice: number, isPyramid = false): Promise<Position> {
    const quantity = order.amountUsd / currentPrice;
    const direction: 'long' | 'short' = order.side === 'sell' ? 'short' : 'long';
    const sideLabel = isPyramid
      ? (direction === 'short' ? 'PYRAMID SHORT' : 'PYRAMID BUY')
      : (direction === 'short' ? 'SHORT' : 'BUY');

    console.error(chalk.cyan(`[DRY RUN] Paper trade: ${sideLabel} ${quantity.toFixed(6)} ${order.tokenId} @ $${currentPrice.toFixed(4)}`));
    console.error(chalk.cyan(`  Size: $${order.amountUsd.toFixed(2)} | SL: $${order.stopLoss.toFixed(4)} | TP: $${order.takeProfit.toFixed(4)}`));

    if (isPyramid) {
      return this.portfolio.addToPosition(order.tokenId, currentPrice, quantity, direction);
    }

    const position = await this.portfolio.openPosition({
      tokenId: order.tokenId,
      symbol: order.tokenId.toUpperCase(),
      side: direction,
      entryPrice: currentPrice,
      currentPrice,
      quantity,
      entryTimestamp: Date.now(),
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      strategy: 'paper',
      atrAtEntry: this.lastAtr,
    });

    return position;
  }

  /** Live execution — dispatches to the configured mode */
  private async executeLive(order: OrderParams, currentPrice?: number): Promise<{ txHash: string; executedPrice: number }> {
    if (this.config.mode === 'hyperliquid-perp') {
      return this.executeHyperliquidPerp(order, currentPrice);
    }
    throw new Error(
      'Live execution requires --mode hyperliquid-perp. ' +
      'Use --dry-run for paper trading.',
    );
  }

  /** Execute a trade on HyperEVM via the HyperliquidPerpStrategy contract */
  private async executeHyperliquidPerp(order: OrderParams, currentPrice?: number): Promise<{ txHash: string; executedPrice: number }> {
    if (!this.config.strategyClone) throw new Error('--strategy-clone is required for hyperliquid-perp mode');
    if (!this.config.proposerPrivateKey) throw new Error('SHERWOOD_PROPOSER_KEY env var is required for live execution');
    if (!currentPrice || currentPrice <= 0) throw new Error('currentPrice is required for live execution');

    const account = privateKeyToAccount(this.config.proposerPrivateKey);
    const chain = this.config.chain === 'hyperevm-testnet' ? hyperevmTestnet : hyperevm;
    const client = createWalletClient({
      account,
      chain,
      transport: http(),
    });

    // Resolve token → HL asset index for multi-asset execution
    const assetIndex = TradeExecutor.resolveAssetIndex(order.tokenId)
      ?? this.config.assetIndex ?? 3; // fallback to config or ETH

    // limitPx: slightly above/below market for IOC (1% slippage buffer)
    const isShort = order.side === 'sell';
    const limitPx = isShort
      ? priceToUint64(currentPrice * 0.99)   // below market for sell IOC
      : priceToUint64(currentPrice * 1.01);  // above market for buy IOC
    // sz: token quantity — fetch asset-specific szDecimals from Hyperliquid meta API
    const quantity = order.amountUsd / currentPrice;
    const szDec = await getSzDecimals(assetIndex);
    const sz = sizeToUint64(quantity, szDec);
    const stopLossPx = priceToUint64(order.stopLoss);
    const stopLossSz = sz;

    // Use multi-asset actions (6/7) that include assetIndex in calldata.
    // One strategy clone can now trade any HL perp asset.
    const action = isShort ? 7 : 6; // ACTION_OPEN_SHORT_MULTI / ACTION_OPEN_LONG_MULTI
    const actionData = encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint32' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }],
      [action, assetIndex, limitPx, sz, stopLossPx, stopLossSz],
    );

    const txData = encodeFunctionData({
      abi: BASE_STRATEGY_ABI,
      functionName: 'updateParams',
      args: [actionData],
    });

    const txHash = await client.sendTransaction({
      to: this.config.strategyClone,
      data: txData,
    });

    console.error(chalk.green(`[LIVE] Transaction sent: ${txHash}`));

    return {
      txHash,
      executedPrice: currentPrice,
    };
  }

  /** Format execution result for display */
  formatExecution(result: {
    success: boolean;
    position?: Position;
    error?: string;
    dryRun: boolean;
  }): string {
    const lines: string[] = [];
    const prefix = result.dryRun ? chalk.cyan('[DRY RUN]') : chalk.green('[LIVE]');

    if (result.success && result.position) {
      const p = result.position;
      lines.push('');
      lines.push(`${prefix} ${chalk.bold('Trade Executed')}`);
      lines.push(chalk.dim('─'.repeat(40)));
      lines.push(`Token: ${p.symbol}`);
      lines.push(`Entry: $${p.entryPrice.toFixed(4)}`);
      lines.push(`Quantity: ${p.quantity.toFixed(6)}`);
      lines.push(`Size: $${(p.quantity * p.entryPrice).toFixed(2)}`);
      lines.push(`Stop Loss: $${p.stopLoss.toFixed(4)}`);
      lines.push(`Take Profit: $${p.takeProfit.toFixed(4)}`);
      lines.push(`Strategy: ${p.strategy}`);
      lines.push('');
    } else {
      lines.push('');
      lines.push(`${prefix} ${chalk.red('Trade Failed')}`);
      lines.push(`Reason: ${result.error}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Update risk gate cycle state */
  updateRiskGateCycle(cycleNumber: number): void {
    this.riskGate.updateCycle(cycleNumber);
  }

  /** Record a position being opened for turnover tracking */
  recordPositionOpened(tokenId: string, side: 'long' | 'short', isReplacement: boolean = false): void {
    this.riskGate.recordPositionOpened(tokenId, side, isReplacement);
  }

  /** Record a position being closed for turnover tracking */
  recordPositionClosed(tokenId: string): void {
    this.riskGate.recordPositionClosed(tokenId);
  }

  /** Get current cycle counters (longs/shorts opened) */
  getRiskGateCycleCounters(): { longsOpened: number; shortsOpened: number } {
    return this.riskGate.getCycleCounters();
  }

  /** Get risk gate configuration */
  getRiskGateConfig(): RiskGateConfig {
    return this.riskGate.getConfig();
  }

  /** Update risk gate configuration */
  updateRiskGateConfig(updates: Partial<RiskGateConfig>): void {
    this.riskGate.updateConfig(updates);
  }
}

// ── HyperCore conversion helpers ──

/** Convert a USD price (e.g. 3000.50) to HyperCore uint64 format (6-decimal fixed point). */
function priceToUint64(priceUsd: number): bigint {
  return BigInt(Math.round(priceUsd * 1e6));
}

/** Convert a token quantity to HyperCore uint64 format using the asset's szDecimals.
 *  HyperCore szDecimals varies per asset — MUST be fetched from the meta API. */
function sizeToUint64(quantity: number, szDecimals: number): bigint {
  return BigInt(Math.round(quantity * 10 ** szDecimals));
}

/** Fetch szDecimals for an asset index from Hyperliquid's meta API.
 *  Caches per session to avoid repeated calls. */
const szDecimalsCache = new Map<number, number>();

async function getSzDecimals(assetIndex: number): Promise<number> {
  if (szDecimalsCache.has(assetIndex)) return szDecimalsCache.get(assetIndex)!;

  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'meta' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = await res.json() as { universe: Array<{ szDecimals: number }> };
    // Cache all assets from the response
    for (let i = 0; i < meta.universe.length; i++) {
      szDecimalsCache.set(i, meta.universe[i]!.szDecimals);
    }
  } catch (err) {
    console.error(`Failed to fetch szDecimals from Hyperliquid meta API: ${err}`);
  }

  const dec = szDecimalsCache.get(assetIndex);
  if (dec === undefined) {
    throw new Error(`Unknown asset index ${assetIndex} — cannot determine szDecimals. Check Hyperliquid meta API.`);
  }
  return dec;
}
