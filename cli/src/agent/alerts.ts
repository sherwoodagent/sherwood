/**
 * Smart alert system for regime transitions and signal changes.
 * Detects meaningful state changes and generates prioritized alerts.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { MarketRegime } from "./regime.js";
import type { TokenAnalysis } from "./index.js";

export type AlertPriority = "critical" | "high" | "medium" | "low";

export interface Alert {
  id: string;              // unique hash
  priority: AlertPriority;
  type: string;            // e.g. "regime-transition", "signal-divergence", "volume-anomaly"
  title: string;           // short headline
  details: string;         // full explanation
  tokenId: string;
  timestamp: number;
  acknowledged: boolean;
  sent: boolean;           // whether alert was sent via Telegram
}

export interface AlertConfig {
  enableRegimeAlerts: boolean;
  enableSignalAlerts: boolean;
  enableVolumeAlerts: boolean;
  minPriority: AlertPriority;
}

interface AlertState {
  lastRegime: MarketRegime | null;
  lastRegimeAt: number;
  lastSignals: Record<string, number>;
  alerts: Alert[];
  lastVolumeCheck: Record<string, { twitterVolume: number; hlVolume?: number; timestamp: number }>;
}

const DEFAULT_CONFIG: AlertConfig = {
  enableRegimeAlerts: true,
  enableSignalAlerts: true,
  enableVolumeAlerts: true,
  minPriority: "medium",
};

export class AlertSystem {
  private stateDir: string;
  private stateFile: string;
  private configFile: string;
  private config: AlertConfig;

  constructor() {
    this.stateDir = join(homedir(), '.sherwood', 'agent');
    this.stateFile = join(this.stateDir, 'alerts-state.json');
    this.configFile = join(this.stateDir, 'alerts-config.json');
    this.config = DEFAULT_CONFIG;
  }

  /**
   * Process analysis results and generate alerts for state changes.
   */
  async processAnalysis(analyses: TokenAnalysis[]): Promise<Alert[]> {
    const state = await this.loadState();
    const newAlerts: Alert[] = [];

    // Process regime transitions (using first analysis result with regime data)
    const regimeAnalysis = analyses.find(a => a.regime);
    if (regimeAnalysis?.regime && this.config.enableRegimeAlerts) {
      const regimeAlerts = this.checkRegimeTransition(state, regimeAnalysis.regime.regime);
      newAlerts.push(...regimeAlerts);

      state.lastRegime = regimeAnalysis.regime.regime;
      state.lastRegimeAt = Date.now();
    }

    // Process signal divergences for each token
    if (this.config.enableSignalAlerts) {
      for (const analysis of analyses) {
        const signalAlerts = this.checkSignalDivergence(state, analysis);
        newAlerts.push(...signalAlerts);

        // Update last signal for this token
        state.lastSignals[analysis.token] = analysis.decision.score;
      }
    }

    // Process volume anomalies if data is available
    if (this.config.enableVolumeAlerts) {
      for (const analysis of analyses) {
        const volumeAlerts = await this.checkVolumeAnomalies(state, analysis);
        newAlerts.push(...volumeAlerts);
      }
    }

    // Add new alerts to state and deduplicate
    for (const alert of newAlerts) {
      if (!this.isAlertDuplicate(state, alert)) {
        state.alerts.push(alert);
      }
    }

    // Prune old alerts (keep last 50)
    if (state.alerts.length > 50) {
      state.alerts = state.alerts.slice(-50);
    }

    await this.saveState(state);
    return newAlerts.filter(alert => this.shouldShowAlert(alert));
  }

  /**
   * Get recent alerts, optionally filtered by priority.
   */
  async getRecentAlerts(maxAge?: number, minPriority?: AlertPriority): Promise<Alert[]> {
    const state = await this.loadState();
    const now = Date.now();
    const ageLimit = maxAge ?? (24 * 60 * 60 * 1000); // Default: 24 hours

    return state.alerts
      .filter(alert => (now - alert.timestamp) <= ageLimit)
      .filter(alert => !minPriority || this.priorityValue(alert.priority) >= this.priorityValue(minPriority))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Clear all alerts by marking them as acknowledged.
   */
  async clearAlerts(): Promise<void> {
    const state = await this.loadState();
    for (const alert of state.alerts) {
      alert.acknowledged = true;
    }
    await this.saveState(state);
  }

  /**
   * Get unsent CRITICAL/HIGH alerts from last 30min and mark them as sent.
   */
  async getUrgentAlerts(): Promise<Alert[]> {
    const state = await this.loadState();
    const now = Date.now();
    const thirtyMinutes = 30 * 60 * 1000;

    // Find unsent critical/high alerts from last 30min
    const urgentAlerts = state.alerts.filter(alert =>
      !alert.sent &&
      !alert.acknowledged &&
      (alert.priority === "critical" || alert.priority === "high") &&
      (now - alert.timestamp) <= thirtyMinutes
    );

    if (urgentAlerts.length === 0) {
      return [];
    }

    // Mark alerts as sent
    for (const alert of urgentAlerts) {
      alert.sent = true;
    }

    await this.saveState(state);
    return urgentAlerts.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Check for regime transitions and generate alerts.
   */
  private checkRegimeTransition(state: AlertState, currentRegime: MarketRegime): Alert[] {
    const alerts: Alert[] = [];

    if (!state.lastRegime || state.lastRegime === currentRegime) {
      return alerts; // No transition
    }

    const transition = `${state.lastRegime} → ${currentRegime}`;

    // Define transition priorities and messages
    const transitionMap: Record<string, { priority: AlertPriority; title: string; details: string }> = {
      "ranging → trending-up": {
        priority: "high",
        title: "Market structure shifted bullish",
        details: "Market regime changed from ranging to trending-up. Breakout strategies now activating. Consider increasing position sizes for momentum plays."
      },
      "ranging → trending-down": {
        priority: "high",
        title: "Market structure shifted bearish",
        details: "Market regime changed from ranging to trending-down. Risk-off mode engaged. Consider reducing exposure and defensive positioning."
      },
      "trending-up → ranging": {
        priority: "medium",
        title: "Uptrend losing momentum",
        details: "Market regime changed from trending-up to ranging. Switching to mean reversion strategies. Momentum strategies reduced effectiveness."
      },
      "trending-up → trending-down": {
        priority: "critical",
        title: "Trend reversal — bull to bear transition",
        details: "Major regime shift from trending-up to trending-down. Consider significant risk reduction and potential short positions."
      },
      "trending-down → trending-up": {
        priority: "critical",
        title: "Trend reversal — bear to bull transition",
        details: "Major regime shift from trending-down to trending-up. Consider increasing long exposure and reducing hedges."
      },
      "trending-up → high-volatility": {
        priority: "high",
        title: "Volatility spike during uptrend",
        details: "Market regime changed to high-volatility from trending-up. Reducing position sizes due to increased uncertainty."
      },
      "trending-down → high-volatility": {
        priority: "high",
        title: "Volatility spike during downtrend",
        details: "Market regime changed to high-volatility from trending-down. Extreme caution advised - reducing position sizes."
      },
      "ranging → high-volatility": {
        priority: "high",
        title: "Volatility breakout from ranging",
        details: "Market regime changed to high-volatility from ranging. Preparing for directional moves but reducing sizes due to uncertainty."
      },
      "high-volatility → trending-up": {
        priority: "medium",
        title: "Volatility normalizing — bullish resolution",
        details: "Market regime stabilized from high-volatility to trending-up. Resuming normal position sizing with bullish bias."
      },
      "high-volatility → trending-down": {
        priority: "medium",
        title: "Volatility normalizing — bearish resolution",
        details: "Market regime stabilized from high-volatility to trending-down. Resuming normal position sizing with bearish bias."
      },
      "high-volatility → ranging": {
        priority: "medium",
        title: "Volatility normalizing — neutral resolution",
        details: "Market regime stabilized from high-volatility to ranging. Resuming normal position sizing, mean reversion strategies activated."
      }
    };

    const transitionData = transitionMap[transition];
    if (transitionData) {
      alerts.push(this.createAlert({
        type: "regime-transition",
        priority: transitionData.priority,
        title: transitionData.title,
        details: transitionData.details,
        tokenId: "bitcoin", // Regime is based on BTC
      }));
    } else {
      // Generic transition alert for unmapped combinations
      alerts.push(this.createAlert({
        type: "regime-transition",
        priority: "medium",
        title: `Market regime changed: ${transition}`,
        details: `Market regime transitioned from ${state.lastRegime} to ${currentRegime}. Adjusting strategy weights accordingly.`,
        tokenId: "bitcoin",
      }));
    }

    return alerts;
  }

  /**
   * Check for significant signal changes.
   */
  private checkSignalDivergence(state: AlertState, analysis: TokenAnalysis): Alert[] {
    const alerts: Alert[] = [];
    const currentScore = analysis.decision.score;
    const lastScore = state.lastSignals[analysis.token];

    if (lastScore === undefined) {
      return alerts; // First time seeing this token
    }

    const scoreChange = currentScore - lastScore;
    const absChange = Math.abs(scoreChange);

    // Signal flip (positive to negative or vice versa)
    if ((lastScore > 0 && currentScore < 0) || (lastScore < 0 && currentScore > 0)) {
      alerts.push(this.createAlert({
        type: "signal-divergence",
        priority: "medium",
        title: `${analysis.token.toUpperCase()} signal flipped ${lastScore > 0 ? 'negative' : 'positive'}`,
        details: `Signal changed from ${lastScore > 0 ? '+' : ''}${lastScore.toFixed(2)} to ${currentScore > 0 ? '+' : ''}${currentScore.toFixed(2)}. Consider reviewing position.`,
        tokenId: analysis.token,
      }));
    }
    // Rapid signal shift (>0.5 change in one scan)
    else if (absChange > 0.5) {
      alerts.push(this.createAlert({
        type: "signal-divergence",
        priority: "high",
        title: `Rapid signal shift for ${analysis.token.toUpperCase()}`,
        details: `Signal changed by ${scoreChange > 0 ? '+' : ''}${scoreChange.toFixed(2)} in one scan (${lastScore.toFixed(2)} → ${currentScore.toFixed(2)}). Significant momentum detected.`,
        tokenId: analysis.token,
      }));
    }

    return alerts;
  }

  /**
   * Check for volume anomalies across Twitter and Hyperliquid.
   */
  private async checkVolumeAnomalies(state: AlertState, analysis: TokenAnalysis): Promise<Alert[]> {
    const alerts: Alert[] = [];

    // This is a placeholder for volume anomaly detection
    // In a real implementation, you would access Twitter and Hyperliquid volume data
    // from the analysis context and compare against historical averages

    const lastVolumeData = state.lastVolumeCheck[analysis.token];
    const now = Date.now();

    // Example logic - you would replace this with actual volume data from analysis
    // if (analysis.data.twitterData?.volumeSpike && analysis.data.hyperliquidData?.volumeRatio) {
    //   const twitterSpike = analysis.data.twitterData.volumeSpike;
    //   const hlVolumeRatio = analysis.data.hyperliquidData.volumeRatio;
    //
    //   if (twitterSpike > 5 && hlVolumeRatio > 2) {
    //     alerts.push(this.createAlert({
    //       type: "volume-anomaly",
    //       priority: "high",
    //       title: `Coordinated volume surge for ${analysis.token.toUpperCase()}`,
    //       details: `Twitter volume ${twitterSpike.toFixed(1)}x spike with ${hlVolumeRatio.toFixed(1)}x Hyperliquid volume. Monitor for breakout.`,
    //       tokenId: analysis.token,
    //     }));
    //   }
    //
    //   // Update volume tracking
    //   state.lastVolumeCheck[analysis.token] = {
    //     twitterVolume: twitterSpike,
    //     hlVolume: hlVolumeRatio,
    //     timestamp: now,
    //   };
    // }

    return alerts;
  }

  /**
   * Create an alert with unique ID and timestamp.
   */
  private createAlert(params: Omit<Alert, 'id' | 'timestamp' | 'acknowledged' | 'sent'>): Alert {
    const content = `${params.type}-${params.tokenId}-${params.title}`;
    const id = createHash('sha256').update(content).digest('hex').substring(0, 12);

    return {
      id,
      timestamp: Date.now(),
      acknowledged: false,
      sent: false,
      ...params,
    };
  }

  /**
   * Check if alert is duplicate within deduplication window.
   */
  private isAlertDuplicate(state: AlertState, newAlert: Alert): boolean {
    const DEDUP_WINDOW = 60 * 60 * 1000; // 1 hour
    const now = Date.now();

    return state.alerts.some(existing =>
      existing.type === newAlert.type &&
      existing.tokenId === newAlert.tokenId &&
      existing.title === newAlert.title &&
      (now - existing.timestamp) < DEDUP_WINDOW &&
      !existing.acknowledged
    );
  }

  /**
   * Determine if alert should be shown based on config.
   */
  private shouldShowAlert(alert: Alert): boolean {
    return this.priorityValue(alert.priority) >= this.priorityValue(this.config.minPriority);
  }

  /**
   * Convert priority to numeric value for comparison.
   */
  private priorityValue(priority: AlertPriority): number {
    const values = { low: 1, medium: 2, high: 3, critical: 4 };
    return values[priority];
  }

  /**
   * Load alert state from disk.
   */
  private async loadState(): Promise<AlertState> {
    try {
      const data = await readFile(this.stateFile, 'utf-8');
      return JSON.parse(data) as AlertState;
    } catch {
      return {
        lastRegime: null,
        lastRegimeAt: 0,
        lastSignals: {},
        alerts: [],
        lastVolumeCheck: {},
      };
    }
  }

  /**
   * Save alert state to disk.
   */
  private async saveState(state: AlertState): Promise<void> {
    try {
      await mkdir(this.stateDir, { recursive: true });
      await writeFile(this.stateFile, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to save alert state: ${(err as Error).message}`);
    }
  }

  /**
   * Format alerts for CLI display.
   */
  formatAlerts(alerts: Alert[], useMarkdown: boolean = false): string {
    if (alerts.length === 0) {
      return useMarkdown ? "*No active alerts*" : "  No active alerts";
    }

    const lines: string[] = [];

    if (useMarkdown) {
      lines.push("## ALERTS");
    } else {
      lines.push("ALERTS");
    }

    for (const alert of alerts.slice(0, 10)) { // Show max 10
      const ageStr = this.formatAge(Date.now() - alert.timestamp);
      const icon = this.getPriorityIcon(alert.priority);

      if (useMarkdown) {
        lines.push(`  ${icon} **${alert.priority.toUpperCase()}**: ${alert.title} (${ageStr})`);
      } else {
        lines.push(`  ${icon} ${alert.priority.toUpperCase()}: ${alert.title} (${ageStr})`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Get emoji icon for alert priority.
   */
  private getPriorityIcon(priority: AlertPriority): string {
    switch (priority) {
      case "critical": return "🔴";
      case "high": return "🟡";
      case "medium": return "🔵";
      case "low": return "⚫";
    }
  }

  /**
   * Format time difference for display.
   */
  private formatAge(ageMs: number): string {
    const minutes = Math.floor(ageMs / (60 * 1000));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return "just now";
  }
}