import { describe, it, expect } from 'vitest';
import { gridCloid } from './cloid.js';

const A1 = '0x0000000000000000000000000000000000000001' as const;
const A2 = '0x0000000000000000000000000000000000000002' as const;

describe('gridCloid', () => {
  it('is deterministic', () => {
    expect(gridCloid(A1, 3, true, 0, 1)).toBe(gridCloid(A1, 3, true, 0, 1));
  });
  it('differs by nonce', () => {
    expect(gridCloid(A1, 3, true, 0, 1)).not.toBe(gridCloid(A1, 3, true, 0, 2));
  });
  it('differs by side', () => {
    expect(gridCloid(A1, 3, true, 0, 1)).not.toBe(gridCloid(A1, 3, false, 0, 1));
  });
  it('differs by asset', () => {
    expect(gridCloid(A1, 3, true, 0, 1)).not.toBe(gridCloid(A1, 4, true, 0, 1));
  });
  it('differs by strategy address', () => {
    expect(gridCloid(A1, 3, true, 0, 1)).not.toBe(gridCloid(A2, 3, true, 0, 1));
  });
  it('fits in uint128', () => {
    expect(gridCloid(A1, 3, true, 0, 1)).toBeLessThan(2n ** 128n);
  });
});
