/**
 * Deterministic risk gate module — hard veto + downgrade system for trade decisions.
 *
 * Provides comprehensive risk filtering including:
 * - Confidence-based vetoes and downgrades
 * - Liquidity/spread quality checks
 * - Turnover control limits
 * - Short-side activation requirements
 * - Microstructure quality validation
 */

import type { TradeDecision } from './scoring.js';
import type { PortfolioState, Position } from './risk.js';

export type GatedAction = 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';

export interface RiskGateResult {
  /** Final action after risk gate processing */
  finalAction: GatedAction;
  /** Original action before gating */
  originalAction: GatedAction;
  /** Array of reason codes explaining gate decisions */
  reasons: string[];
  /** Whether the original decision was modified */
  wasGated: boolean;
  /** Short-side specific validation results */
  shortValidation?: {
    confidencePassed: boolean;
    thresholdPassed: boolean;
    notionalCapsPassed: boolean;
  };
}

export interface RiskGateConfig {
  /** Hard veto confidence threshold for BUY/STRONG_BUY */
  buyVetoConfidenceThreshold: number;
  /** High volatility confidence threshold for downgrades */
  highVolatilityConfidenceThreshold: number;
  /** Maximum concurrent entries per cycle */
  maxConcurrentEntriesPerCycle: number;
  /** Maximum position replacements per cycle */
  maxReplacementsPerCycle: number;
  /** Minimum hold cycles before flip/close (unless stop-loss emergency) */
  minHoldCycles: number;
  /** Short-side minimum confidence requirement */
  shortMinConfidence: number;
  /** Short-side additional threshold buffer (below sell threshold) */
  shortThresholdBuffer: number;
  /** Enable hard veto mode (vs downgrade mode) */
  hardVetoMode: boolean;
  /** Liquidity quality thresholds */
  liquidityThresholds: {
    /** Maximum spread percentage (bid-ask / mid) */
    maxSpreadPercent: number;
    /** Minimum 24h volume USD */
    minVolume24hUsd: number;
    /** Minimum market cap USD */
    minMarketCapUsd: number;
  };
}

export const DEFAULT_RISK_GATE_CONFIG: RiskGateConfig = {
  buyVetoConfidenceThreshold: 0.45,
  highVolatilityConfidenceThreshold: 0.60,
  maxConcurrentEntriesPerCycle: 8,
  maxReplacementsPerCycle: 2,
  minHoldCycles: 2,
  shortMinConfidence: 0.55,
  shortThresholdBuffer: 0.05,
  hardVetoMode: true,
  liquidityThresholds: {
    maxSpreadPercent: 0.02, // 2% max spread
    minVolume24hUsd: 100_000, // $100k minimum 24h volume
    minMarketCapUsd: 10_000_000, // $10M minimum market cap
  },
};

export interface MarketData {
  /** Current bid price */
  bid?: number;
  /** Current ask price */
  ask?: number;
  /** 24 hour volume in USD */
  volume24hUsd?: number;
  /** Market cap in USD */
  marketCapUsd?: number;
  /** Current volatility measure (e.g., 20-day) */
  volatility?: number;
  /** Liquidity depth at various levels */
  depthBid?: number;
  depthAsk?: number;
}

export interface TurnoverState {
  /** Positions opened this cycle */
  currentCycleEntries: number;
  /** Positions replaced this cycle */
  currentCycleReplacements: number;
  /** Cycle when each position was opened */
  positionCycleMap: Record<string, number>;
  /** Current cycle number */
  currentCycle: number;
}

export interface CycleCounters {
  /** Number of long positions opened in current cycle */
  longsOpened: number;
  /** Number of short positions opened in current cycle */
  shortsOpened: number;
}

export class RiskGate {
  private config: RiskGateConfig;
  private turnoverState: TurnoverState;
  private cycleCounters: CycleCounters;

  constructor(config?: Partial<RiskGateConfig>) {
    this.config = { ...DEFAULT_RISK_GATE_CONFIG, ...config };
    this.turnoverState = {
      currentCycleEntries: 0,
      currentCycleReplacements: 0,
      positionCycleMap: {},
      currentCycle: 0,
    };
    this.cycleCounters = {
      longsOpened: 0,
      shortsOpened: 0,
    };
  }

  /**
   * Apply risk gate logic to a trade decision.
   * Returns gated action with reason codes.
   */
  applyGate(
    tokenId: string,
    decision: TradeDecision,
    portfolio: PortfolioState,
    marketData: MarketData,
    sellThreshold: number = -0.25, // Default sell threshold for short validation
  ): RiskGateResult {
    const originalAction = decision.action as GatedAction;
    const reasons: string[] = [];
    let finalAction = originalAction;
    let wasGated = false;

    // 1. Confidence-based veto/downgrade for BUY/STRONG_BUY
    if ((originalAction === 'BUY' || originalAction === 'STRONG_BUY')) {
      if (decision.confidence < this.config.buyVetoConfidenceThreshold) {
        if (this.config.hardVetoMode) {
          finalAction = 'HOLD';
          reasons.push(`BUY_CONFIDENCE_VETO: confidence ${decision.confidence.toFixed(3)} < threshold ${this.config.buyVetoConfidenceThreshold}`);
          wasGated = true;
        } else {
          // Downgrade mode
          finalAction = originalAction === 'STRONG_BUY' ? 'BUY' : 'HOLD';
          reasons.push(`BUY_CONFIDENCE_DOWNGRADE: confidence ${decision.confidence.toFixed(3)} < threshold ${this.config.buyVetoConfidenceThreshold}`);
          wasGated = true;
        }
      }
    }

    // 2. Liquidity/spread quality check
    const liquidityResult = this.checkLiquidityQuality(marketData);
    if (!liquidityResult.passed) {
      if (liquidityResult.missingData) {
        // Conservative downgrade for missing microstructure data
        if (originalAction === 'STRONG_BUY') {
          finalAction = 'BUY';
          reasons.push('MISSING_MICROSTRUCTURE: conservative downgrade due to missing market data');
          wasGated = true;
        } else if (originalAction === 'BUY') {
          finalAction = 'HOLD';
          reasons.push('MISSING_MICROSTRUCTURE: conservative downgrade due to missing market data');
          wasGated = true;
        } else if (originalAction === 'STRONG_SELL') {
          finalAction = 'SELL';
          reasons.push('MISSING_MICROSTRUCTURE: conservative downgrade due to missing market data');
          wasGated = true;
        } else if (originalAction === 'SELL') {
          finalAction = 'HOLD';
          reasons.push('MISSING_MICROSTRUCTURE: conservative downgrade due to missing market data');
          wasGated = true;
        }
      } else {
        // Poor liquidity quality - downgrade or veto
        finalAction = 'HOLD';
        reasons.push(`LIQUIDITY_VETO: ${liquidityResult.reason}`);
        wasGated = true;
      }
    }

    // 3. High volatility + low confidence downgrade
    if (marketData.volatility && marketData.volatility > 0.1) { // > 10% volatility
      if (decision.confidence < this.config.highVolatilityConfidenceThreshold) {
        if (originalAction === 'STRONG_BUY') {
          finalAction = 'BUY';
          reasons.push(`HIGH_VOL_DOWNGRADE: volatility ${(marketData.volatility * 100).toFixed(1)}%, confidence ${decision.confidence.toFixed(3)} < ${this.config.highVolatilityConfidenceThreshold}`);
          wasGated = true;
        } else if (originalAction === 'BUY') {
          finalAction = 'HOLD';
          reasons.push(`HIGH_VOL_DOWNGRADE: volatility ${(marketData.volatility * 100).toFixed(1)}%, confidence ${decision.confidence.toFixed(3)} < ${this.config.highVolatilityConfidenceThreshold}`);
          wasGated = true;
        } else if (originalAction === 'STRONG_SELL') {
          finalAction = 'SELL';
          reasons.push(`HIGH_VOL_DOWNGRADE: volatility ${(marketData.volatility * 100).toFixed(1)}%, confidence ${decision.confidence.toFixed(3)} < ${this.config.highVolatilityConfidenceThreshold}`);
          wasGated = true;
        } else if (originalAction === 'SELL') {
          finalAction = 'HOLD';
          reasons.push(`HIGH_VOL_DOWNGRADE: volatility ${(marketData.volatility * 100).toFixed(1)}%, confidence ${decision.confidence.toFixed(3)} < ${this.config.highVolatilityConfidenceThreshold}`);
          wasGated = true;
        }
      }
    }

    // 4. Turnover control
    if (finalAction === 'BUY' || finalAction === 'STRONG_BUY' || finalAction === 'SELL' || finalAction === 'STRONG_SELL') {
      const turnoverCheck = this.checkTurnoverLimits(tokenId, portfolio);
      if (!turnoverCheck.allowed) {
        finalAction = 'HOLD';
        reasons.push(`TURNOVER_LIMIT: ${turnoverCheck.reason}`);
        wasGated = true;
      }
    }

    // 5. Short-side activation checks
    let shortValidation: RiskGateResult['shortValidation'];
    if (finalAction === 'SELL' || finalAction === 'STRONG_SELL') {
      shortValidation = this.validateShortEntry(decision, sellThreshold, portfolio);
      if (!shortValidation.confidencePassed || !shortValidation.thresholdPassed || !shortValidation.notionalCapsPassed) {
        finalAction = 'HOLD';
        reasons.push(`SHORT_VALIDATION_FAILED: confidence=${shortValidation.confidencePassed}, threshold=${shortValidation.thresholdPassed}, caps=${shortValidation.notionalCapsPassed}`);
        wasGated = true;
      }
    }

    // 6. Position hold time check (prevent premature flips unless stop-loss emergency)
    // Apply this check to the original action, not the gated one
    if (originalAction !== 'HOLD') {
      const holdTimeCheck = this.checkMinimumHoldTime(tokenId, originalAction);
      if (!holdTimeCheck.allowed) {
        finalAction = 'HOLD';
        reasons.push(`MIN_HOLD_TIME: ${holdTimeCheck.reason}`);
        wasGated = true;
      }
    }

    return {
      finalAction,
      originalAction,
      reasons,
      wasGated,
      shortValidation,
    };
  }

  /**
   * Check liquidity/spread quality from available market data
   */
  private checkLiquidityQuality(marketData: MarketData): { passed: boolean; missingData: boolean; reason?: string } {
    const { bid, ask, volume24hUsd, marketCapUsd } = marketData;
    const thresholds = this.config.liquidityThresholds;

    // Check if key data is missing
    const hasPriceData = bid !== undefined && ask !== undefined && bid > 0 && ask > 0;
    const hasVolumeData = volume24hUsd !== undefined && volume24hUsd > 0;
    const hasMarketCapData = marketCapUsd !== undefined && marketCapUsd > 0;

    if (!hasPriceData && !hasVolumeData && !hasMarketCapData) {
      return { passed: false, missingData: true };
    }

    // Check spread if price data is available
    if (hasPriceData) {
      const mid = (bid! + ask!) / 2;
      const spread = ask! - bid!;
      const spreadPercent = mid > 0 ? spread / mid : 1;

      if (spreadPercent > thresholds.maxSpreadPercent) {
        return {
          passed: false,
          missingData: false,
          reason: `spread ${(spreadPercent * 100).toFixed(2)}% > max ${(thresholds.maxSpreadPercent * 100).toFixed(1)}%`
        };
      }
    }

    // Check volume threshold
    if (hasVolumeData && volume24hUsd! < thresholds.minVolume24hUsd) {
      return {
        passed: false,
        missingData: false,
        reason: `24h volume $${volume24hUsd!.toLocaleString()} < min $${thresholds.minVolume24hUsd.toLocaleString()}`
      };
    }

    // Check market cap threshold
    if (hasMarketCapData && marketCapUsd! < thresholds.minMarketCapUsd) {
      return {
        passed: false,
        missingData: false,
        reason: `market cap $${marketCapUsd!.toLocaleString()} < min $${thresholds.minMarketCapUsd.toLocaleString()}`
      };
    }

    return { passed: true, missingData: false };
  }

  /**
   * Check turnover limits (max entries and replacements per cycle)
   */
  private checkTurnoverLimits(tokenId: string, portfolio: PortfolioState): { allowed: boolean; reason?: string } {
    // Check if this would be a new entry vs existing position modification
    const existingPosition = portfolio.positions.find(p => p.tokenId === tokenId);
    const positionOpenedThisCycle = this.turnoverState.positionCycleMap[tokenId] === this.turnoverState.currentCycle;
    const isNewEntry = !existingPosition;

    if (isNewEntry) {
      // Check concurrent entries limit
      if (this.turnoverState.currentCycleEntries >= this.config.maxConcurrentEntriesPerCycle) {
        return {
          allowed: false,
          reason: `max ${this.config.maxConcurrentEntriesPerCycle} concurrent entries per cycle reached (${this.turnoverState.currentCycleEntries})`
        };
      }
    } else if (!positionOpenedThisCycle) {
      // This would be a replacement/flip of existing position from prior cycle
      if (this.turnoverState.currentCycleReplacements >= this.config.maxReplacementsPerCycle) {
        return {
          allowed: false,
          reason: `max ${this.config.maxReplacementsPerCycle} replacements per cycle reached (${this.turnoverState.currentCycleReplacements})`
        };
      }
    }
    // If position was opened this cycle, allow additional modifications (pyramiding, etc.)

    return { allowed: true };
  }

  /**
   * Validate short-side entry requirements
   */
  private validateShortEntry(
    decision: TradeDecision,
    sellThreshold: number,
    portfolio: PortfolioState
  ): NonNullable<RiskGateResult['shortValidation']> {
    // Check confidence threshold
    const confidencePassed = decision.confidence >= this.config.shortMinConfidence;

    // Check score threshold (must be below sell threshold minus buffer)
    const requiredThreshold = sellThreshold - this.config.shortThresholdBuffer;
    const thresholdPassed = decision.score <= requiredThreshold;

    // Check notional caps (simplified - could integrate with existing risk manager)
    const portfolioValue = portfolio.totalValue || portfolio.cash;
    const shortExposure = portfolio.positions
      .filter(p => p.side === 'short')
      .reduce((sum, p) => sum + (p.quantity * p.currentPrice), 0);
    const shortExposurePercent = portfolioValue > 0 ? shortExposure / portfolioValue : 0;
    const notionalCapsPassed = shortExposurePercent < 0.3; // Max 30% short exposure

    return {
      confidencePassed,
      thresholdPassed,
      notionalCapsPassed,
    };
  }

  /**
   * Check minimum hold time before allowing flips/closes (unless stop-loss emergency)
   */
  private checkMinimumHoldTime(tokenId: string, proposedAction: GatedAction): { allowed: boolean; reason?: string } {
    const positionCycle = this.turnoverState.positionCycleMap[tokenId];

    if (positionCycle === undefined) {
      // No existing position, allow entry
      return { allowed: true };
    }

    // Only apply minimum hold time to actions that would close or flip existing position
    if (proposedAction === 'HOLD') {
      return { allowed: true };
    }

    const cyclesHeld = this.turnoverState.currentCycle - positionCycle;

    if (cyclesHeld < this.config.minHoldCycles) {
      // TODO: Add stop-loss emergency check here when integrating with portfolio tracker
      // For now, enforce minimum hold time for any non-HOLD action
      return {
        allowed: false,
        reason: `position held ${cyclesHeld} cycles, min ${this.config.minHoldCycles} required`
      };
    }

    return { allowed: true };
  }

  /**
   * Update turnover state for new cycle
   */
  updateCycle(cycleNumber: number): void {
    this.turnoverState.currentCycle = cycleNumber;
    this.turnoverState.currentCycleEntries = 0;
    this.turnoverState.currentCycleReplacements = 0;
    this.cycleCounters.longsOpened = 0;
    this.cycleCounters.shortsOpened = 0;
  }

  /**
   * Record a new position opening
   */
  recordPositionOpened(tokenId: string, side: 'long' | 'short', isReplacement: boolean = false): void {
    if (isReplacement) {
      this.turnoverState.currentCycleReplacements++;
    } else {
      this.turnoverState.currentCycleEntries++;
    }

    this.turnoverState.positionCycleMap[tokenId] = this.turnoverState.currentCycle;

    // Update counters
    if (side === 'long') {
      this.cycleCounters.longsOpened++;
    } else {
      this.cycleCounters.shortsOpened++;
    }
  }

  /**
   * Record a position being closed
   */
  recordPositionClosed(tokenId: string): void {
    delete this.turnoverState.positionCycleMap[tokenId];
  }

  /**
   * Get current cycle counters for reporting
   */
  getCycleCounters(): CycleCounters {
    return { ...this.cycleCounters };
  }

  /**
   * Get risk gate configuration
   */
  getConfig(): RiskGateConfig {
    return { ...this.config };
  }

  /**
   * Update risk gate configuration
   */
  updateConfig(updates: Partial<RiskGateConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Get current turnover state for debugging
   */
  getTurnoverState(): TurnoverState {
    return { ...this.turnoverState };
  }
}