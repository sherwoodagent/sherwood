/**
 * Telegram-optimized alert formatting for trading notifications.
 * Formats scan results, regime changes, and alerts with emoji indicators.
 */

import type { Alert, TokenAnalysis } from "./index.js";
import type { MarketRegime } from "./regime.js";

export class AlertFormatter {

  /**
   * Format alerts for Telegram with priority grouping and emoji indicators.
   * Returns null if no alerts to display.
   */
  static formatForTelegram(alerts: Alert[]): string | null {
    if (alerts.length === 0) return null;

    // Group by priority
    const grouped: Record<string, Alert[]> = {
      critical: [],
      high: [],
      medium: [],
      low: []
    };

    for (const alert of alerts) {
      grouped[alert.priority].push(alert);
    }

    const lines: string[] = [];
    lines.push("🚨 *TRADING ALERTS*");

    // Critical alerts
    if (grouped.critical.length > 0) {
      lines.push("\n🔴 *CRITICAL*");
      for (const alert of grouped.critical.slice(0, 3)) {
        lines.push(`• ${alert.title}`);
        if (alert.tokenId !== 'bitcoin') {
          lines.push(`  _${alert.tokenId.toUpperCase()}_`);
        }
      }
    }

    // High priority alerts
    if (grouped.high.length > 0) {
      lines.push("\n🟡 *HIGH*");
      for (const alert of grouped.high.slice(0, 3)) {
        lines.push(`• ${alert.title}`);
        if (alert.tokenId !== 'bitcoin') {
          lines.push(`  _${alert.tokenId.toUpperCase()}_`);
        }
      }
    }

    // Medium priority alerts
    if (grouped.medium.length > 0) {
      lines.push("\n🔵 *MEDIUM*");
      for (const alert of grouped.medium.slice(0, 2)) {
        lines.push(`• ${alert.title}`);
      }
    }

    // Low priority alerts (only show count)
    if (grouped.low.length > 0) {
      lines.push(`\n⚫ ${grouped.low.length} low priority alerts`);
    }

    const result = lines.join("\n");

    // Telegram message limit is 4096 chars
    if (result.length > 4000) {
      return result.substring(0, 3900) + "\n\n_...truncated_";
    }

    return result;
  }

  /**
   * Format comprehensive scan summary with opportunities, top movers, and alerts.
   */
  static formatScanSummary(
    results: TokenAnalysis[],
    alerts: Alert[],
    regime?: MarketRegime
  ): string {
    const lines: string[] = [];

    // Header with timestamp
    lines.push("📊 *MARKET SCAN SUMMARY*");
    lines.push(`_${new Date().toLocaleTimeString()}_`);

    // Market regime
    if (regime) {
      const regimeEmoji = regime === "trending-up" ? "📈" :
                         regime === "trending-down" ? "📉" :
                         regime === "ranging" ? "↔️" :
                         regime === "high-volatility" ? "🌋" : "🔄";
      lines.push(`\n${regimeEmoji} *Regime:* ${regime.toUpperCase().replace('-', ' ')}`);
    }

    // Check if all signals are HOLD (brief mode)
    const allHold = results.every(r => r.decision.action === "HOLD");

    if (allHold) {
      // Brief format for all HOLD scenario
      const strongest = results.reduce((max, r) =>
        r.decision.score > max.decision.score ? r : max
      );
      const weakest = results.reduce((min, r) =>
        r.decision.score < min.decision.score ? r : min
      );

      const fearGreed = results[0]?.data.fearAndGreed;
      const fgText = fearGreed ?
        (fearGreed < 25 ? "Extreme Fear" :
         fearGreed < 40 ? "Fear" :
         fearGreed < 60 ? "Neutral" :
         fearGreed < 75 ? "Greed" : "Extreme Greed") : "Unknown";

      lines.push(`\n🔄 *All positions HOLD*`);
      lines.push(`💪 Strongest: ${strongest.token.toUpperCase()} (+${strongest.decision.score.toFixed(2)})`);
      lines.push(`💤 Weakest: ${weakest.token.toUpperCase()} (${weakest.decision.score.toFixed(2)})`);
      if (fearGreed) {
        lines.push(`😱 F&G: ${fearGreed} (${fgText})`);
      }
    } else {
      // Full format with opportunities and movers

      // Opportunities (score > 0.3)
      const opportunities = results.filter(r =>
        r.decision.score > 0.3 && (r.decision.action === "BUY" || r.decision.action === "STRONG_BUY")
      ).sort((a, b) => b.decision.score - a.decision.score);

      if (opportunities.length > 0) {
        lines.push("\n💡 *OPPORTUNITIES*");
        for (const opp of opportunities.slice(0, 3)) {
          const action = opp.decision.action === "STRONG_BUY" ? "🚀 STRONG BUY" : "📈 BUY";
          lines.push(`${action} ${opp.token.toUpperCase()} (${opp.decision.score.toFixed(2)})`);

          // Top signal
          const topSignal = opp.decision.signals
            .filter(s => Math.abs(s.value) > 0.1)
            .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];

          if (topSignal) {
            const signalEmoji = topSignal.value > 0 ? "⬆️" : "⬇️";
            lines.push(`  ${signalEmoji} ${topSignal.source}: ${topSignal.value > 0 ? "+" : ""}${topSignal.value.toFixed(2)}`);
          }
        }
      }

      // Top movers (biggest absolute score changes)
      const topMovers = results
        .filter(r => Math.abs(r.decision.score) > 0.2)
        .sort((a, b) => Math.abs(b.decision.score) - Math.abs(a.decision.score))
        .slice(0, 3);

      if (topMovers.length > 0) {
        lines.push("\n🎯 *TOP MOVERS*");
        for (const mover of topMovers) {
          const scoreEmoji = mover.decision.score > 0 ? "📈" : "📉";
          lines.push(`${scoreEmoji} ${mover.token.toUpperCase()}: ${mover.decision.score > 0 ? "+" : ""}${mover.decision.score.toFixed(2)}`);
        }
      }
    }

    // Alerts section
    const alertText = this.formatForTelegram(alerts);
    if (alertText) {
      lines.push(`\n${alertText}`);
    }

    const result = lines.join("\n");

    // Respect Telegram limit
    if (result.length > 4000) {
      return result.substring(0, 3900) + "\n\n_...truncated_";
    }

    return result;
  }
}