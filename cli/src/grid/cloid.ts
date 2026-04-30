/**
 * Deterministic CLOID generator for grid orders.
 *
 * CLOID = uint128 = keccak256(assetIndex, isBuy, levelIndex, nonce)[0:16]
 *
 * The nonce is per-grid-rebuild — increments when a token's grid is
 * rebuilt/shifted, making prior CLOIDs stale (so `cancel-all` for a token
 * uses the OLD nonce's CLOIDs).
 */

import { keccak256, encodeAbiParameters } from 'viem';

export function gridCloid(
  assetIndex: number,
  isBuy: boolean,
  levelIndex: number,
  nonce: number,
): bigint {
  const hash = keccak256(
    encodeAbiParameters(
      [
        { type: 'uint32' },
        { type: 'bool' },
        { type: 'uint32' },
        { type: 'uint32' },
      ],
      [assetIndex, isBuy, levelIndex, nonce],
    ),
  );
  // Take the high 16 bytes as uint128
  const top16 = (hash as string).slice(0, 2 + 32); // '0x' + 32 hex chars = 16 bytes
  return BigInt(top16);
}
