#!/usr/bin/env python3
"""
Kronos volatility forecaster — predicts N future price paths from OHLCV candles,
outputs predicted volatility and directional bias as JSON.

Usage:
  echo '<json>' | python3 kronos_predict.py [--samples 5] [--pred-len 24]

Input (JSON on stdin):
  {
    "candles": [
      {"timestamp": 1700000000000, "open": 78000, "high": 78500, "low": 77500, "close": 78200, "volume": 1234},
      ...
    ]
  }

Output (JSON on stdout):
  {
    "predictedVolatility": 0.035,       // annualized vol from path spread
    "predictedVol4h": 0.012,            // per-candle (4h) volatility
    "directionalBias": 0.15,            // -1 to +1 (mean path direction)
    "pathSpreadPct": 5.2,               // % spread between worst and best path at horizon
    "predictionHorizon": 24,            // number of candles predicted
    "sampleCount": 5,                   // number of Monte Carlo paths
    "lastClose": 78200,                 // last input close
    "meanPredictedClose": 79500,        // mean of path endpoints
    "inferenceTimeMs": 2200,            // total inference time
    "modelName": "Kronos-mini"
  }
"""

import json
import sys
import os
import time
import argparse

import numpy as np
import pandas as pd
import torch

# Add the kronos model to path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from kronos_model import Kronos, KronosTokenizer, KronosPredictor

# ── Global model cache (loaded once per process) ──
_predictor = None
_load_time = 0


def get_predictor():
    """Load model + tokenizer once, cache globally."""
    global _predictor, _load_time
    if _predictor is not None:
        return _predictor

    t0 = time.time()
    tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
    model = Kronos.from_pretrained("NeoQuasar/Kronos-mini")
    _predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=512)
    _load_time = time.time() - t0
    return _predictor


def predict_volatility(candles, pred_len=24, sample_count=5):
    """
    Run Kronos inference on OHLCV candles and compute volatility metrics.

    Args:
        candles: list of dicts with open/high/low/close/volume keys
        pred_len: number of future candles to predict
        sample_count: number of Monte Carlo paths

    Returns:
        dict with volatility metrics
    """
    predictor = get_predictor()
    t0 = time.time()

    # Build DataFrame
    df = pd.DataFrame(candles)

    # Ensure required columns
    for col in ['open', 'high', 'low', 'close']:
        if col not in df.columns:
            return {"error": f"Missing required column: {col}"}

    if 'volume' not in df.columns:
        df['volume'] = 0.0
    if 'amount' not in df.columns:
        df['amount'] = 0.0

    # Build timestamps from the candle timestamps or generate synthetic ones
    if 'timestamp' in df.columns:
        # Assume millisecond timestamps, 4h apart
        ts = pd.to_datetime(df['timestamp'], unit='ms')
    else:
        # Generate synthetic timestamps (4h intervals)
        ts = pd.date_range(end=pd.Timestamp.now(), periods=len(df), freq='4h')

    x_timestamp = pd.Series(ts)
    last_ts = ts.iloc[-1] if hasattr(ts, 'iloc') else ts[-1]
    y_timestamp = pd.Series(pd.date_range(
        start=last_ts + pd.Timedelta(hours=4),
        periods=pred_len,
        freq='4h'
    ))

    input_df = df[['open', 'high', 'low', 'close', 'volume', 'amount']].copy()

    # Run N independent samples (each with sample_count=1 for diversity)
    paths = []
    for _ in range(sample_count):
        try:
            pred = predictor.predict(
                df=input_df,
                x_timestamp=x_timestamp,
                y_timestamp=y_timestamp,
                pred_len=pred_len,
                T=1.0,
                top_p=0.9,
                sample_count=1,
                verbose=False,
            )
            paths.append(pred['close'].values)
        except Exception as e:
            # Skip failed samples
            continue

    inference_ms = int((time.time() - t0) * 1000)

    if len(paths) < 2:
        return {"error": "Not enough valid paths generated", "inferenceTimeMs": inference_ms}

    path_array = np.array(paths)  # shape: (N, pred_len)
    last_close = float(df['close'].iloc[-1])

    # ── Compute metrics ──

    # Per-step volatility (std across paths at each timestep)
    step_vol = np.std(path_array, axis=0)
    mean_path = np.mean(path_array, axis=0)

    # Relative vol per step (as fraction of mean price)
    rel_vol_per_step = step_vol / (np.abs(mean_path) + 1e-8)
    predicted_vol_4h = float(np.mean(rel_vol_per_step))

    # Annualize: 4h candles, 6 per day, 365 days
    annualized_vol = predicted_vol_4h * np.sqrt(6 * 365)

    # Directional bias: mean endpoint vs last close, scaled to [-1, 1]
    mean_endpoint = float(np.mean(path_array[:, -1]))
    direction = (mean_endpoint - last_close) / (last_close + 1e-8)
    # Scale: 5% move = ±1.0
    directional_bias = float(np.clip(direction / 0.05, -1, 1))

    # Path spread at horizon
    max_endpoint = float(np.max(path_array[:, -1]))
    min_endpoint = float(np.min(path_array[:, -1]))
    path_spread_pct = float((max_endpoint - min_endpoint) / (last_close + 1e-8) * 100)

    return {
        "predictedVolatility": round(annualized_vol, 4),
        "predictedVol4h": round(predicted_vol_4h, 5),
        "directionalBias": round(directional_bias, 3),
        "pathSpreadPct": round(path_spread_pct, 2),
        "predictionHorizon": pred_len,
        "sampleCount": len(paths),
        "lastClose": round(last_close, 2),
        "meanPredictedClose": round(mean_endpoint, 2),
        "inferenceTimeMs": inference_ms,
        "modelName": "Kronos-mini",
    }


def main():
    parser = argparse.ArgumentParser(description="Kronos volatility forecaster")
    parser.add_argument("--samples", type=int, default=5, help="Number of Monte Carlo paths")
    parser.add_argument("--pred-len", type=int, default=24, help="Number of future candles to predict")
    args = parser.parse_args()

    # Read JSON from stdin
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    candles = data.get("candles", [])
    if len(candles) < 30:
        print(json.dumps({"error": f"Need at least 30 candles, got {len(candles)}"}))
        sys.exit(1)

    result = predict_volatility(candles, pred_len=args.pred_len, sample_count=args.samples)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
