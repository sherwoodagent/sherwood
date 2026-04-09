/**
 * Risk management module — position sizing, drawdown limits, stop-loss management.
 */

import chalk from 'chalk';

export interface PortfolioState {
  totalValue: number;
  positions: Position[];
  cash: number;
  dailyPnl: number;
  weeklyPnl: number;
  monthlyPnl: number;
  lastDailyReset?: number;
  lastWeeklyReset?: number;
  lastMonthlyReset?: number;
}

export interface Position {
  tokenId: string;
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  entryTimestamp: number;
  stopLoss: number;
  takeProfit: number;
  trailingStop?: number;
  strategy: string;
  pnlPercent: number;
  pnlUsd: number;
}

export interface RiskConfig {
  maxPortfolioRisk: number;
  maxSinglePosition: number;
  maxCorrelatedExposure: number;
  maxConcurrentTrades: number;
  hardStopPercent: number;
  trailingStopAtr: number;
  dailyLossLimit: number;
  weeklyLossLimit: number;
  monthlyLossLimit: number;
  maxSlippage: Record<string, number>;
  riskPerTrade: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxPortfolioRisk: 0.15,
  maxSinglePosition: 0.10,
  maxCorrelatedExposure: 0.20,
  maxConcurrentTrades: 8,
  hardStopPercent: 0.12,
  trailingStopAtr: 1.5,
  dailyLossLimit: 0.05,
  weeklyLossLimit: 0.10,
  monthlyLossLimit: 0.15,
  maxSlippage: { large: 0.005, mid: 0.015, small: 0.03 },
  riskPerTrade: 0.02,
};

const EMPTY_PORTFOLIO: PortfolioState = {
  totalValue: 0,
  positions: [],
  cash: 0,
  dailyPnl: 0,
  weeklyPnl: 0,
  monthlyPnl: 0,
};

export class RiskManager {
  private config: RiskConfig;
  private portfolio: PortfolioState;

  constructor(config?: Partial<RiskConfig>) {
    this.config = { ...DEFAULT_RISK_CONFIG, ...config };
    this.portfolio = { ...EMPTY_PORTFOLIO };
  }

  /** Check if we can open a new position */
  canOpenPosition(token: string, sizeUsd: number): { allowed: boolean; reason?: string } {
    // Check concurrent trades limit
    if (this.portfolio.positions.length >= this.config.maxConcurrentTrades) {
      return { allowed: false, reason: `Max concurrent trades (${this.config.maxConcurrentTrades}) reached` };
    }

    // Check single position size limit
    const portfolioValue = this.portfolio.totalValue || this.portfolio.cash;
    if (portfolioValue > 0) {
      const positionPct = sizeUsd / portfolioValue;
      if (positionPct > this.config.maxSinglePosition) {
        return {
          allowed: false,
          reason: `Position size ${(positionPct * 100).toFixed(1)}% exceeds max ${(this.config.maxSinglePosition * 100).toFixed(0)}% per trade`,
        };
      }
    }

    // Check total portfolio risk by evaluating potential aggregate loss
    if (portfolioValue > 0) {
      const currentRiskExposure = this.portfolio.positions.reduce(
        (sum, p) => {
          // Estimate max loss per position using stop loss distance
          const maxLossPerPosition = Math.abs(p.entryPrice - p.stopLoss) * p.quantity;
          return sum + maxLossPerPosition;
        },
        0,
      );

      // Estimate new position risk (assuming 8% stop loss)
      const newPositionRisk = sizeUsd * 0.08;
      const totalRiskExposure = currentRiskExposure + newPositionRisk;

      if (totalRiskExposure / portfolioValue > this.config.maxPortfolioRisk) {
        return {
          allowed: false,
          reason: `Total portfolio risk ${(totalRiskExposure / portfolioValue * 100).toFixed(1)}% would exceed max ${(this.config.maxPortfolioRisk * 100).toFixed(0)}%`,
        };
      }
    }

    // Check if we already have a position in this token
    const existing = this.portfolio.positions.find((p) => p.tokenId === token);
    if (existing) {
      return { allowed: false, reason: `Already have an open position in ${token}` };
    }

    // Check cash availability
    if (sizeUsd > this.portfolio.cash) {
      return { allowed: false, reason: `Insufficient cash: need $${sizeUsd.toFixed(2)}, have $${this.portfolio.cash.toFixed(2)}` };
    }

    // Check drawdown limits
    const drawdown = this.isDrawdownLimitHit();
    if (drawdown.paused) {
      return { allowed: false, reason: drawdown.message };
    }

    // Check correlated exposure by token category
    const TOKEN_CATEGORIES: Record<string, string> = {
      bitcoin: 'L1', ethereum: 'L1', solana: 'L1', avalanche: 'L1', cardano: 'L1',
      polkadot: 'L1', near: 'L1', cosmos: 'L1', sui: 'L1', aptos: 'L1',
      uniswap: 'DeFi', aave: 'DeFi', maker: 'DeFi', compound: 'DeFi', curve: 'DeFi',
      lido: 'DeFi', sushi: 'DeFi', pancakeswap: 'DeFi', jupiter: 'DeFi',
      arbitrum: 'L2', optimism: 'L2', polygon: 'L2', 'starknet': 'L2', base: 'L2',
      'zksync': 'L2', mantle: 'L2',
    };

    const tokenCategory = TOKEN_CATEGORIES[token];
    if (tokenCategory && portfolioValue > 0) {
      const correlatedExposure = this.portfolio.positions
        .filter((p) => TOKEN_CATEGORIES[p.tokenId] === tokenCategory)
        .reduce((sum, p) => sum + p.quantity * p.currentPrice, 0);
      const newExposure = (correlatedExposure + sizeUsd) / portfolioValue;
      if (newExposure > this.config.maxCorrelatedExposure) {
        return {
          allowed: false,
          reason: `Correlated exposure for ${tokenCategory} would be ${(newExposure * 100).toFixed(1)}% (limit: ${(this.config.maxCorrelatedExposure * 100).toFixed(0)}%)`,
        };
      }
    }

    return { allowed: true };
  }

  /** Calculate position size using classic risk-based formula */
  calculatePositionSize(
    entryPrice: number,
    stopLossPrice: number,
    portfolioValue: number,
    maxRiskPercent?: number,
  ): { quantity: number; sizeUsd: number; riskUsd: number } {
    // Guard against invalid inputs
    if (entryPrice <= 0 || portfolioValue <= 0) {
      return { quantity: 0, sizeUsd: 0, riskUsd: 0 };
    }

    const riskPct = maxRiskPercent ?? this.config.riskPerTrade;
    const riskUsd = portfolioValue * riskPct;
    const riskPerUnit = Math.abs(entryPrice - stopLossPrice);

    if (riskPerUnit <= 0) {
      return { quantity: 0, sizeUsd: 0, riskUsd: 0 };
    }

    // positionSize = (portfolioValue * maxRiskPercent) / (entryPrice - stopLossPrice)
    const quantity = riskUsd / riskPerUnit;
    const sizeUsd = quantity * entryPrice;

    // Cap at max single position size
    const maxSizeUsd = portfolioValue * this.config.maxSinglePosition;
    if (sizeUsd > maxSizeUsd) {
      const cappedQuantity = maxSizeUsd / entryPrice;
      return {
        quantity: cappedQuantity,
        sizeUsd: maxSizeUsd,
        riskUsd: cappedQuantity * riskPerUnit,
      };
    }

    return { quantity, sizeUsd, riskUsd };
  }

  /** Check drawdown limits — returns true if trading should be paused */
  isDrawdownLimitHit(): { paused: boolean; level: 'daily' | 'weekly' | 'monthly' | null; message: string } {
    const portfolioValue = this.portfolio.totalValue || this.portfolio.cash;
    if (portfolioValue <= 0) {
      return { paused: false, level: null, message: 'No portfolio value set' };
    }

    const dailyPct = Math.abs(this.portfolio.dailyPnl) / portfolioValue;
    const weeklyPct = Math.abs(this.portfolio.weeklyPnl) / portfolioValue;
    const monthlyPct = Math.abs(this.portfolio.monthlyPnl) / portfolioValue;

    if (this.portfolio.dailyPnl < 0 && dailyPct >= this.config.dailyLossLimit) {
      return {
        paused: true,
        level: 'daily',
        message: `Daily loss limit hit: ${(dailyPct * 100).toFixed(1)}% (limit: ${(this.config.dailyLossLimit * 100).toFixed(0)}%)`,
      };
    }

    if (this.portfolio.weeklyPnl < 0 && weeklyPct >= this.config.weeklyLossLimit) {
      return {
        paused: true,
        level: 'weekly',
        message: `Weekly loss limit hit: ${(weeklyPct * 100).toFixed(1)}% (limit: ${(this.config.weeklyLossLimit * 100).toFixed(0)}%)`,
      };
    }

    if (this.portfolio.monthlyPnl < 0 && monthlyPct >= this.config.monthlyLossLimit) {
      return {
        paused: true,
        level: 'monthly',
        message: `Monthly loss limit hit: ${(monthlyPct * 100).toFixed(1)}% (limit: ${(this.config.monthlyLossLimit * 100).toFixed(0)}%)`,
      };
    }

    return { paused: false, level: null, message: 'Within limits' };
  }

  /** Update trailing stop losses using ATR values */
  updateStopLosses(positions: Position[], atrValues: Record<string, number>): Position[] {
    return positions.map((pos) => {
      const atr = atrValues[pos.tokenId];
      if (atr === undefined || atr <= 0) return pos;

      const trailingDistance = atr * this.config.trailingStopAtr;
      const newTrailingStop = pos.currentPrice - trailingDistance;

      // Only move trailing stop up, never down
      const currentTrailing = pos.trailingStop ?? pos.stopLoss;
      if (newTrailingStop > currentTrailing) {
        return {
          ...pos,
          trailingStop: newTrailingStop,
          // Also update hard stop if trailing is higher
          stopLoss: Math.max(pos.stopLoss, newTrailingStop),
        };
      }

      return pos;
    });
  }

  /** Check if any positions should be closed */
  checkExits(
    positions: Position[],
    currentPrices: Record<string, number>,
  ): { toClose: Position[]; reasons: Record<string, string> } {
    const toClose: Position[] = [];
    const reasons: Record<string, string> = {};

    for (const pos of positions) {
      const price = currentPrices[pos.tokenId];
      if (price === undefined) continue;

      // Update current price for evaluation
      const updatedPos = { ...pos, currentPrice: price };
      const pnlPercent = (price - pos.entryPrice) / pos.entryPrice;

      // Hard stop loss check
      if (pnlPercent <= -this.config.hardStopPercent) {
        toClose.push(updatedPos);
        reasons[pos.tokenId] = `Hard stop hit: ${(pnlPercent * 100).toFixed(1)}% loss (limit: -${(this.config.hardStopPercent * 100).toFixed(0)}%)`;
        continue;
      }

      // Stop loss check
      if (price <= pos.stopLoss) {
        toClose.push(updatedPos);
        reasons[pos.tokenId] = `Stop loss hit at $${pos.stopLoss.toFixed(4)} (price: $${price.toFixed(4)})`;
        continue;
      }

      // Trailing stop check
      if (pos.trailingStop !== undefined && price <= pos.trailingStop) {
        toClose.push(updatedPos);
        reasons[pos.tokenId] = `Trailing stop hit at $${pos.trailingStop.toFixed(4)} (price: $${price.toFixed(4)})`;
        continue;
      }

      // Take profit check
      if (price >= pos.takeProfit) {
        toClose.push(updatedPos);
        reasons[pos.tokenId] = `Take profit hit at $${pos.takeProfit.toFixed(4)} (price: $${price.toFixed(4)})`;
        continue;
      }

      // Time-based exit: positions open > 7 days with < 2% profit
      const holdingDays = (Date.now() - pos.entryTimestamp) / (1000 * 60 * 60 * 24);
      if (holdingDays > 7 && pnlPercent < 0.02 && pnlPercent > -0.02) {
        toClose.push(updatedPos);
        reasons[pos.tokenId] = `Time stop: held ${holdingDays.toFixed(0)} days with only ${(pnlPercent * 100).toFixed(1)}% PnL`;
        continue;
      }
    }

    return { toClose, reasons };
  }

  /** Update portfolio state */
  updatePortfolio(portfolio: Partial<PortfolioState>): void {
    this.portfolio = { ...this.portfolio, ...portfolio };
  }

  /** Get current risk exposure summary */
  getRiskSummary(): string {
    const lines: string[] = [];
    const pv = this.portfolio.totalValue || this.portfolio.cash;

    lines.push(chalk.bold('Risk Summary'));
    lines.push(chalk.dim('─'.repeat(40)));
    lines.push(`Portfolio Value: $${pv.toFixed(2)}`);
    lines.push(`Cash: $${this.portfolio.cash.toFixed(2)}`);
    lines.push(`Open Positions: ${this.portfolio.positions.length}/${this.config.maxConcurrentTrades}`);

    const totalExposure = this.portfolio.positions.reduce(
      (sum, p) => sum + p.quantity * p.currentPrice,
      0,
    );
    const exposurePct = pv > 0 ? (totalExposure / pv) * 100 : 0;
    lines.push(`Total Exposure: $${totalExposure.toFixed(2)} (${exposurePct.toFixed(1)}%)`);

    const totalUnrealizedPnl = this.portfolio.positions.reduce((sum, p) => sum + p.pnlUsd, 0);
    const pnlColor = totalUnrealizedPnl >= 0 ? chalk.green : chalk.red;
    lines.push(`Unrealized PnL: ${pnlColor('$' + totalUnrealizedPnl.toFixed(2))}`);

    lines.push(chalk.dim('─'.repeat(40)));
    lines.push(`Daily PnL: ${this.portfolio.dailyPnl >= 0 ? '+' : ''}$${this.portfolio.dailyPnl.toFixed(2)}`);
    lines.push(`Weekly PnL: ${this.portfolio.weeklyPnl >= 0 ? '+' : ''}$${this.portfolio.weeklyPnl.toFixed(2)}`);
    lines.push(`Monthly PnL: ${this.portfolio.monthlyPnl >= 0 ? '+' : ''}$${this.portfolio.monthlyPnl.toFixed(2)}`);

    const drawdown = this.isDrawdownLimitHit();
    if (drawdown.paused) {
      lines.push(chalk.red(`TRADING PAUSED: ${drawdown.message}`));
    }

    return lines.join('\n');
  }
}
