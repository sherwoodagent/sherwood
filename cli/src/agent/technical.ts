/**
 * Technical analysis module — pure calculation functions.
 * All functions use standard financial formulas.
 */

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalSignals {
  rsi: number;
  macd: { value: number; signal: number; histogram: number };
  bb: { upper: number; middle: number; lower: number; width: number; squeeze: boolean };
  ema: { ema8: number; ema21: number; ema50: number; ema200: number };
  atr: number;
  vwap: number;
  volume: { current: number; avg20: number; ratio: number };
}

// ── Simple Moving Average ──

export function calculateSMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];

  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sum += values[j]!;
      }
      result.push(sum / period);
    }
  }
  return result;
}

// ── Exponential Moving Average ──

export function calculateEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];

  const result: number[] = [];
  const k = 2 / (period + 1);

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else if (i === period - 1) {
      // Seed with SMA of first `period` valid values
      let sum = 0;
      let count = 0;
      for (let j = 0; j < period; j++) {
        if (!isNaN(values[j]!)) {
          sum += values[j]!;
          count++;
        }
      }
      if (count > 0) {
        result.push(sum / count);
      } else {
        result.push(NaN);
      }
    } else {
      const prev = result[i - 1]!;
      const current = values[i]!;
      if (!isNaN(current) && !isNaN(prev)) {
        result.push(current * k + prev * (1 - k));
      } else {
        result.push(NaN);
      }
    }
  }
  return result;
}

// ── RSI (Relative Strength Index) ──

export function calculateRSI(candles: Candle[], period: number = 14): number[] {
  if (candles.length < 2) return [];

  const closes = candles.map((c) => c.close);
  const result: number[] = [];

  // Calculate price changes
  const changes: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      changes.push(0);
    } else {
      changes.push(closes[i]! - closes[i - 1]!);
    }
  }

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      result.push(NaN);
      continue;
    }

    if (i === period) {
      // Sum gains and losses for changes[1..period]
      let sumGain = 0;
      let sumLoss = 0;
      for (let j = 1; j <= period; j++) {
        const change = changes[j]!;
        sumGain += Math.max(change, 0);
        sumLoss += Math.max(-change, 0);
      }
      avgGain = sumGain / period;
      avgLoss = sumLoss / period;
    } else {
      // Use Wilder's smoothing (exponential smoothing with alpha = 1/period)
      const change = changes[i]!;
      const alpha = 1 / period;
      avgGain = (1 - alpha) * avgGain + alpha * Math.max(change, 0);
      avgLoss = (1 - alpha) * avgLoss + alpha * Math.max(-change, 0);
    }

    if (avgLoss === 0) {
      result.push(100);
    } else {
      const rs = avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    }
  }

  return result;
}

// ── MACD ──

export function calculateMACD(
  candles: Candle[],
  fast: number = 12,
  slow: number = 26,
  signalPeriod: number = 9,
): { macd: number[]; signal: number[]; histogram: number[] } {
  const closes = candles.map((c) => c.close);
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);

  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(emaFast[i]!) || isNaN(emaSlow[i]!)) {
      macdLine.push(NaN);
    } else {
      macdLine.push(emaFast[i]! - emaSlow[i]!);
    }
  }

  // Signal line = EMA of MACD line
  // Calculate EMA directly on the MACD line, which will handle NaN values internally
  const signalLine = calculateEMA(macdLine, signalPeriod);

  const histogram: number[] = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (isNaN(macdLine[i]!) || isNaN(signalLine[i]!)) {
      histogram.push(NaN);
    } else {
      histogram.push(macdLine[i]! - signalLine[i]!);
    }
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

// ── Bollinger Bands ──

export function calculateBollingerBands(
  candles: Candle[],
  period: number = 20,
  stdDevMult: number = 2.0,
): { upper: number[]; middle: number[]; lower: number[]; width: number[] } {
  if (candles.length === 0) {
    return { upper: [], middle: [], lower: [], width: [] };
  }

  const closes = candles.map((c) => c.close);
  const middle = calculateSMA(closes, period);

  const upper: number[] = [];
  const lower: number[] = [];
  const width: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (isNaN(middle[i]!)) {
      upper.push(NaN);
      lower.push(NaN);
      width.push(NaN);
    } else {
      let sumSq = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sumSq += (closes[j]! - middle[i]!) ** 2;
      }
      const sd = Math.sqrt(sumSq / period);
      upper.push(middle[i]! + stdDevMult * sd);
      lower.push(middle[i]! - stdDevMult * sd);
      width.push(middle[i]! !== 0 ? (stdDevMult * 2 * sd) / middle[i]! : 0);
    }
  }

  return { upper, middle, lower, width };
}

// ── Average True Range ──

export function calculateATR(candles: Candle[], period: number = 14): number[] {
  if (candles.length === 0) return [];

  const trueRanges: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (i === 0) {
      trueRanges.push(c.high - c.low);
    } else {
      const prev = candles[i - 1]!;
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
      trueRanges.push(tr);
    }
  }

  // ATR = smoothed average of true ranges (Wilder's smoothing)
  const result: number[] = [];
  for (let i = 0; i < trueRanges.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += trueRanges[j]!;
      result.push(sum / period);
    } else {
      result.push((result[i - 1]! * (period - 1) + trueRanges[i]!) / period);
    }
  }
  return result;
}

// ── VWAP (Volume Weighted Average Price) ──

export function calculateVWAP(candles: Candle[]): number[] {
  const result: number[] = [];
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativeTPV += typicalPrice * c.volume;
    cumulativeVolume += c.volume;
    result.push(cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice);
  }
  return result;
}

// ── Bollinger Band Squeeze Detection ──

export function detectBBSqueeze(candles: Candle[]): boolean {
  const bb = calculateBollingerBands(candles, 20, 2.0);
  const validWidths = bb.width.filter((w) => !isNaN(w));
  if (validWidths.length < 20) return false;

  const current = validWidths[validWidths.length - 1]!;
  const recent20 = validWidths.slice(-20);
  const minWidth = Math.min(...recent20);
  return current <= minWidth * 1.01; // within 1% of 20-period low
}

// ── Get Latest Signals (all indicators at current candle) ──

export function getLatestSignals(candles: Candle[]): TechnicalSignals {
  if (candles.length < 2) {
    throw new Error("Need at least 2 candles for technical analysis");
  }

  const last = (arr: number[]): number => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!isNaN(arr[i]!)) return arr[i]!;
    }
    return NaN;
  };

  const rsiArr = calculateRSI(candles, 14);
  const macdResult = calculateMACD(candles, 12, 26, 9);
  const bbResult = calculateBollingerBands(candles, 20, 2.0);
  const closes = candles.map((c) => c.close);
  const ema8 = calculateEMA(closes, 8);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const atrArr = calculateATR(candles, 14);
  const vwapArr = calculateVWAP(candles);

  // Volume stats
  const volumes = candles.map((c) => c.volume);
  const currentVol = volumes[volumes.length - 1] ?? 0;
  const recent20Vol = volumes.slice(-20);
  const avg20Vol = recent20Vol.length > 0 ? recent20Vol.reduce((a, b) => a + b, 0) / recent20Vol.length : 0;

  return {
    rsi: last(rsiArr),
    macd: {
      value: last(macdResult.macd),
      signal: last(macdResult.signal),
      histogram: last(macdResult.histogram),
    },
    bb: {
      upper: last(bbResult.upper),
      middle: last(bbResult.middle),
      lower: last(bbResult.lower),
      width: last(bbResult.width),
      squeeze: detectBBSqueeze(candles),
    },
    ema: {
      ema8: last(ema8),
      ema21: last(ema21),
      ema50: last(ema50),
      ema200: last(ema200),
    },
    atr: last(atrArr),
    vwap: last(vwapArr),
    volume: {
      current: currentVol,
      avg20: avg20Vol,
      ratio: avg20Vol > 0 ? currentVol / avg20Vol : 0,
    },
  };
}
