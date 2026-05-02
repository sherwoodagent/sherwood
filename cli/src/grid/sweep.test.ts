import { describe, it, expect } from 'vitest';
import { expandSweep } from './sweep.js';
import { DEFAULT_GRID_CONFIG } from './config.js';

describe('expandSweep', () => {
  const base = {
    leverage: DEFAULT_GRID_CONFIG.leverage,
    levelsPerSide: DEFAULT_GRID_CONFIG.levelsPerSide,
    atrMultiplier: DEFAULT_GRID_CONFIG.atrMultiplier,
    rebalanceDriftPct: DEFAULT_GRID_CONFIG.rebalanceDriftPct,
  };

  it('produces single combo when no sweeps specified', () => {
    const combos = expandSweep({}, base);
    expect(combos).toHaveLength(1);
    expect(combos[0]).toEqual(base);
  });

  it('produces N combos for N values of one field', () => {
    const combos = expandSweep({ leverage: [2, 5, 10] }, base);
    expect(combos).toHaveLength(3);
    const levs = combos.map(c => c.leverage);
    expect(levs).toEqual([2, 5, 10]);
  });

  it('produces Cartesian product across two fields', () => {
    const combos = expandSweep({ leverage: [2, 5], levelsPerSide: [10, 15, 20] }, base);
    expect(combos).toHaveLength(6);
    // Each leverage value paired with each levels value
    for (const lev of [2, 5]) {
      for (const lvls of [10, 15, 20]) {
        expect(combos.find(c => c.leverage === lev && c.levelsPerSide === lvls)).toBeDefined();
      }
    }
  });

  it('falls back to base values for non-swept fields', () => {
    const combos = expandSweep({ leverage: [3] }, base);
    expect(combos).toHaveLength(1);
    expect(combos[0]!.levelsPerSide).toBe(base.levelsPerSide);
    expect(combos[0]!.atrMultiplier).toBe(base.atrMultiplier);
    expect(combos[0]!.rebalanceDriftPct).toBe(base.rebalanceDriftPct);
  });

  it('treats empty arrays as "no sweep"', () => {
    const combos = expandSweep({ leverage: [] }, base);
    expect(combos).toHaveLength(1);
    expect(combos[0]!.leverage).toBe(base.leverage);
  });
});
