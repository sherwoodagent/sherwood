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

export class TradeExecutor {
  private config: ExecutionConfig;
  private riskManager: RiskManager;
  private portfolio: PortfolioTracker;

  constructor(config: ExecutionConfig, riskManager: RiskManager, portfolio: PortfolioTracker) {
    this.config = config;
    this.riskManager = riskManager;
    this.portfolio = portfolio;
  }

  /** Execute a trade based on a decision */
  async execute(
    decision: TradeDecision,
    tokenId: string,
    currentPrice: number,
  ): Promise<{
    success: boolean;
    position?: Position;
    error?: string;
    dryRun: boolean;
  }> {
    // Handle SELL/STRONG_SELL by closing existing long positions
    if (decision.action === 'SELL' || decision.action === 'STRONG_SELL') {
      const sellState = await this.portfolio.load();
      const existing = sellState.positions.find((p) => p.tokenId === tokenId);
      if (!existing) {
        return {
          success: false,
          error: `No open position in ${tokenId} to sell`,
          dryRun: this.config.dryRun,
        };
      }

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

    // Only execute buys on BUY or STRONG_BUY; HOLD does nothing
    if (decision.action !== 'BUY' && decision.action !== 'STRONG_BUY') {
      return {
        success: false,
        error: `Action ${decision.action} does not trigger execution`,
        dryRun: this.config.dryRun,
      };
    }

    // Load portfolio to get current state
    const state = await this.portfolio.load();
    this.riskManager.updatePortfolio(state);

    // Calculate stop loss and take profit from current price
    const stopLossDistance = currentPrice * 0.08; // 8% default stop
    const stopLossPrice = currentPrice - stopLossDistance;
    const takeProfitPrice = currentPrice * (1 + 0.08 * 2.5); // 2.5:1 reward/risk

    // Size the position using risk management
    const sizing = this.riskManager.calculatePositionSize(
      currentPrice,
      stopLossPrice,
      state.totalValue,
    );

    if (sizing.quantity <= 0 || sizing.sizeUsd <= 0) {
      return {
        success: false,
        error: 'Position sizing returned zero — check portfolio value and stop distance',
        dryRun: this.config.dryRun,
      };
    }

    // Check if risk manager allows this trade
    const check = this.riskManager.canOpenPosition(tokenId, sizing.sizeUsd);
    if (!check.allowed) {
      return {
        success: false,
        error: `Risk check failed: ${check.reason}`,
        dryRun: this.config.dryRun,
      };
    }

    const order: OrderParams = {
      tokenId,
      side: 'buy',
      amountUsd: sizing.sizeUsd,
      maxSlippage: 0.015,
      stopLoss: stopLossPrice,
      takeProfit: takeProfitPrice,
    };

    if (this.config.dryRun) {
      try {
        const position = await this.executeDryRun(order, currentPrice);
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
        const position = await this.portfolio.openPosition({
          tokenId,
          symbol: tokenId.toUpperCase(),
          entryPrice: result.executedPrice,
          currentPrice: result.executedPrice,
          quantity: sizing.quantity,
          entryTimestamp: Date.now(),
          stopLoss: order.stopLoss,
          takeProfit: order.takeProfit,
          strategy: decision.signals[0]?.source ?? 'agent',
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

    return results;
  }

  /** Dry-run execution — paper trade */
  private async executeDryRun(order: OrderParams, currentPrice: number): Promise<Position> {
    const quantity = order.amountUsd / currentPrice;

    console.error(chalk.cyan(`[DRY RUN] Paper trade: BUY ${quantity.toFixed(6)} ${order.tokenId} @ $${currentPrice.toFixed(4)}`));
    console.error(chalk.cyan(`  Size: $${order.amountUsd.toFixed(2)} | SL: $${order.stopLoss.toFixed(4)} | TP: $${order.takeProfit.toFixed(4)}`));

    const position = await this.portfolio.openPosition({
      tokenId: order.tokenId,
      symbol: order.tokenId.toUpperCase(),
      entryPrice: currentPrice,
      currentPrice,
      quantity,
      entryTimestamp: Date.now(),
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      strategy: 'paper',
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

    // limitPx: slightly above market for buy IOC (1% slippage buffer)
    const limitPx = priceToUint64(currentPrice * 1.01);
    // sz: token quantity — fetch asset-specific szDecimals from Hyperliquid meta API
    const quantity = order.amountUsd / currentPrice;
    const assetIndex = this.config.assetIndex ?? 3; // default ETH
    const szDec = await getSzDecimals(assetIndex);
    const sz = sizeToUint64(quantity, szDec);
    const stopLossPx = priceToUint64(order.stopLoss);
    const stopLossSz = sz;

    // Encode ACTION_OPEN_LONG (action=1)
    const actionData = encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }],
      [1, limitPx, sz, stopLossPx, stopLossSz],
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
