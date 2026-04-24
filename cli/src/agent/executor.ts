/**
 * Trade execution module — dry-run paper trading + live execution placeholder.
 */

import chalk from 'chalk';
import type { Address, Hex } from 'viem';
import type { TradeDecision } from './scoring.js';
import type { Position } from './risk.js';
import { RiskManager } from './risk.js';
import { PortfolioTracker } from './portfolio.js';
import { hlMarketBuy, hlMarketSell, resolveHLCoin, validateHLEnv } from '../lib/hyperliquid-executor.js';

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
}

export interface OrderParams {
  tokenId: string;
  side: 'buy' | 'sell';
  amountUsd: number;
  maxSlippage: number;
  stopLoss: number;
  takeProfit: number;
}

/** Directional trade leverage. Grid uses 4x; directional uses 3x for
 *  tighter stops. Risk is controlled via riskPerTrade (2%) — leverage
 *  amplifies returns without increasing the sizing formula's risk budget.
 *
 *  Cash model note: paper trading debits full notional (qty × price) for
 *  longs and 20% margin for shorts. On a real perp venue, both sides use
 *  margin (~20-33%). This means paper cash depletes faster than reality
 *  for leveraged longs — intentionally conservative to avoid overestimating
 *  available capital. Live mode (hyperliquid-perp) uses venue margin. */
// Autoresearch (80 exp, 4 days): 3x→2x→1x each reduced DD dramatically.
// At 54% WR with avg loss > avg win, leverage amplifies the problem.
// Revert to 1x until WR > 60% and avg win > avg loss.
const DIRECTIONAL_LEVERAGE = 1;

/** Score-based position sizing multiplier.
 *  Nunchi autoresearch (103 experiments): removing strength/volume scaling
 *  improved Sharpe by +1.7. Uniform position sizing beats conviction-weighted
 *  because the score predicts DIRECTION, not MAGNITUDE. A high-score entry
 *  isn't more likely to be a BIG winner — it's just more likely to be RIGHT.
 *  Oversizing on high scores amplifies losses on the 40% that still stop out.
 *  Kept as a function for easy revert if calibration proves otherwise. */
function convictionMultiplier(_score: number): number {
  return 1.0; // uniform sizing — autoresearch-proven
}

export class TradeExecutor {
  private config: ExecutionConfig;
  private riskManager: RiskManager;
  private portfolio: PortfolioTracker;
  private lastAtr?: number;

  constructor(config: ExecutionConfig, riskManager: RiskManager, portfolio: PortfolioTracker) {
    this.config = config;
    this.riskManager = riskManager;
    this.portfolio = portfolio;
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

  /** Execute a trade based on a decision.
   *  @param predictedVol - Kronos ML-predicted per-candle volatility (fraction).
   *    When provided, overrides ATR-based stop distance for more forward-looking risk. */
  async execute(
    decision: TradeDecision,
    tokenId: string,
    currentPrice: number,
    atr?: number,
    predictedVol?: number,
  ): Promise<{
    success: boolean;
    position?: Position;
    error?: string;
    dryRun: boolean;
  }> {
    // Token blacklist — serial losers identified from trade analysis.
    // AAVE: 4 trades, 1W, -$145. FARTCOIN: 2 trades, 0W, -$118.
    const BLACKLISTED_TOKENS = new Set(['aave', 'fartcoin']);
    if (BLACKLISTED_TOKENS.has(tokenId)) {
      return {
        success: false,
        error: `Token ${tokenId} is blacklisted (serial loser)`,
        dryRun: this.config.dryRun,
      };
    }

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

    // Minimum conviction gate — filter out marginal "just barely crossed the
    // threshold" entries. Trade log review (25 trades): the 3 losing shorts
    // scored -0.10 to -0.15, winning longs scored 0.20-0.40+. Entries below
    // 0.18 absolute score have a much higher stop-out rate because they
    // represent weak signal consensus rather than genuine directional edge.
    // Minimum conviction — set below the lowest regime BUY threshold (ranging 0.17)
    // to avoid a dead zone where scores pass the threshold but fail conviction.
    // Prior value 0.12 created a [0.12, 0.17) dead zone.
    const MIN_CONVICTION_SCORE = 0.08;
    if (Math.abs(decision.score) < MIN_CONVICTION_SCORE) {
      return {
        success: false,
        error: `Score ${decision.score.toFixed(3)} below minimum conviction (${MIN_CONVICTION_SCORE})`,
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

    // Calculate stop loss and take profit from current price.
    // Calibrated for SHORT-TERM trades (1-2 day hold) with leverage:
    //   Stop: 4% price move × 3x leverage = 12% capital risk (capped by riskPerTrade)
    //   Take profit: 1.5:1 R:R = 6% price move × 3x = 18% capital gain
    //   Partial exit at 2% move × 3x = 6% capital gain (locks half)
    //   Time stop: 96h (see risk.ts) — if it hasn't moved, it's dead money
    const isShort = decision.action === 'SELL' || decision.action === 'STRONG_SELL';
    const direction: 'long' | 'short' = isShort ? 'short' : 'long';
    const RR_RATIO = 1.5;  // was 2.0 — 9.4% TP was unrealistic, 1.5:1 hits more often
    // Nunchi autoresearch (103 experiments): wider ATR stops let winners run.
    // Their optimal was 5.5x ATR; we use 3.5x as a compromise between letting
    // winners breathe and controlling loss on stopped trades. Prior 1.5x was
    // too tight — 64% of trades hit the stop, many of which reversed after.
    const ATR_STOP_MULTIPLIER = 3.5;
    // Trade log analysis (32 trades): 62.5% of exits were stops, many reversed
    // after. Widened floor from 3% → 4% to give trades more room to breathe
    // in crypto's noisy price action. ATR-based stops still dominate on
    // higher-vol tokens where ATR × 3.5 > 4%.
    const STOP_FLOOR = 0.05;   // minimum 5% (was 4% — still noise-stopping, 63% of exits are stops)
    const STOP_CAP = 0.12;     // maximum 12% (tightened from 15%)
    const FALLBACK_STOP = 0.05; // when no ATR available (was 4%)

    // Kronos ML-predicted vol overrides ATR when available.
    // predictedVol4h is the per-candle (4h) volatility from Monte Carlo paths.
    // Use 2.5× predicted vol as stop distance (captures ~95% of expected move).
    // Falls back to ATR×3.5 when Kronos is unavailable.
    const KRONOS_STOP_MULTIPLIER = 2.5;
    const useKronos = predictedVol && Number.isFinite(predictedVol) && predictedVol > 0;
    const atrPct = (atr && currentPrice > 0 && !isNaN(atr))
      ? atr / currentPrice
      : FALLBACK_STOP / ATR_STOP_MULTIPLIER;
    const kronosPct = useKronos ? predictedVol! * KRONOS_STOP_MULTIPLIER : 0;
    const rawStopPct = useKronos ? kronosPct : atrPct * ATR_STOP_MULTIPLIER;
    const stopPct = Math.min(STOP_CAP, Math.max(STOP_FLOOR, rawStopPct));
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
    // Short sizing reduction: trade log analysis showed 25% short WR vs 67%
    // long WR. Halve short exposure until the regime gate + higher conviction
    // thresholds improve short performance.
    const SHORT_SIZE_MULTIPLIER = 0.5;
    const directionMultiplier = isShort ? SHORT_SIZE_MULTIPLIER : 1.0;
    const sizeMultiplier = (isPyramid
      ? 0.5 ** ((existingSameSide!.addCount ?? 0) + 1)
      : 1.0) * directionMultiplier;

    // Size the position using risk management. Conviction is fed in via the
    // risk budget — the sizer then clamps at maxSinglePosition, so a
    // high-conviction entry cannot blow past the hard cap (previous bug:
    // sizing was clamped, then multiplied by conviction after, yielding 30%
    // sizes on score ≥ 0.35 and 40% on score ≥ 0.45 against a 20% cap).
    const conviction = convictionMultiplier(decision.score);
    const sizing = this.riskManager.calculatePositionSize(
      currentPrice,
      stopLossPrice,
      state.totalValue,
      this.riskManager.getRiskPerTrade() * conviction,
    );

    // Apply leverage: multiply position size (not risk). A 3x leveraged position
    // on a $500 risk budget buys $1500 notional — the stop loss distance stays the
    // same in price terms, so the dollar risk per trade stays at riskPerTrade × portfolio.
    // Pyramid haircut then shrinks for each subsequent add (base 1.0x → 0.5x → 0.25x).
    const pyramidQuantity = sizing.quantity * sizeMultiplier * DIRECTIONAL_LEVERAGE;
    const pyramidSizeUsd = sizing.sizeUsd * sizeMultiplier * DIRECTIONAL_LEVERAGE;

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
        return { success: true, position, dryRun: true };
      } catch (err) {
        return {
          success: false,
          error: `Dry-run failed: ${(err as Error).message}`,
          dryRun: true,
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
              strategy: decision.signals[0]?.source ?? 'agent',
              atrAtEntry: this.lastAtr,
            });
        return { success: true, position, dryRun: false };
      } catch (err) {
        return {
          success: false,
          error: `Live execution failed: ${(err as Error).message}`,
          dryRun: false,
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
    // Reload state after each partial close to avoid iterating stale positions.
    const PARTIAL_PROFIT_TRIGGER = 0.015; // +1.5% unrealized gain — lock profits earlier at 1x leverage
    const PARTIAL_FRACTION = 0.5;

    // First pass: identify candidates from a fresh load
    const partialCandidates: string[] = [];
    {
      const refreshedState = await this.portfolio.load();
      for (const pos of refreshedState.positions) {
        if (pos.partialTaken) continue;
        const price = currentPrices[pos.tokenId];
        if (price === undefined) continue;
        const isShort = pos.side === 'short';
        const pnlPercent = isShort
          ? (pos.entryPrice - price) / (pos.entryPrice || 1)
          : (price - pos.entryPrice) / (pos.entryPrice || 1);
        if (pnlPercent >= PARTIAL_PROFIT_TRIGGER) {
          partialCandidates.push(pos.tokenId);
        }
      }
    }

    // Second pass: execute each partial close with a fresh state reload
    for (const tokenId of partialCandidates) {
      const freshState = await this.portfolio.load();
      const pos = freshState.positions.find((p) => p.tokenId === tokenId);
      if (!pos || pos.partialTaken) continue; // re-check after reload

      const price = currentPrices[tokenId];
      if (price === undefined) continue;

      const isShort = pos.side === 'short';
      const pnlPercent = isShort
        ? (pos.entryPrice - price) / (pos.entryPrice || 1)
        : (price - pos.entryPrice) / (pos.entryPrice || 1);

      if (pnlPercent >= PARTIAL_PROFIT_TRIGGER) {
        try {
          const partial = await this.portfolio.closePartial(
            tokenId, PARTIAL_FRACTION, price, `Partial profit at ${(pnlPercent * 100).toFixed(1)}%`,
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

    console.error(chalk.cyan(`[DRY RUN] Paper trade: ${sideLabel} ${quantity.toFixed(6)} ${order.tokenId} @ $${currentPrice.toFixed(4)} (${DIRECTIONAL_LEVERAGE}x)`));
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

  /** Execute a trade on Hyperliquid perps via the hermes HL skill script. */
  private async executeHyperliquidPerp(order: OrderParams, currentPrice?: number): Promise<{ txHash: string; executedPrice: number }> {
    validateHLEnv();
    if (!currentPrice || currentPrice <= 0) throw new Error('currentPrice is required for live execution');

    const hlCoin = resolveHLCoin(order.tokenId);
    if (!hlCoin) {
      throw new Error(`Token ${order.tokenId} has no known Hyperliquid ticker — cannot execute live`);
    }

    const quantity = order.amountUsd / currentPrice;
    const isShort = order.side === 'sell';

    console.error(chalk.yellow(`[LIVE] Submitting ${isShort ? 'SELL' : 'BUY'} ${quantity.toFixed(6)} ${hlCoin} ($${order.amountUsd.toFixed(2)}) via HL SDK...`));

    const result = isShort
      ? await hlMarketSell(hlCoin, quantity)
      : await hlMarketBuy(hlCoin, quantity);

    if (!result.success) {
      throw new Error(`Hyperliquid order failed: ${result.error}`);
    }

    const executedPrice = result.executedPrice ?? currentPrice;
    const orderId = result.orderId ?? 'unknown';

    console.error(chalk.green(`[LIVE] Order filled: ${hlCoin} ${isShort ? 'SHORT' : 'LONG'} @ $${executedPrice.toFixed(4)} (oid: ${orderId})`));

    return {
      txHash: orderId, // HL order ID serves as the "tx hash" identifier
      executedPrice,
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
}

