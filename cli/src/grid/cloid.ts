/**
 * Deterministic CLOID generator for grid orders.
 *
 * CLOID = uint128 = keccak256(strategy, assetIndex, isBuy, levelIndex, nonce)[0:16]
 *
 * Including the strategy address namespaces CLOIDs per-deployment so two
 * grid strategies running on the same HL account can't collide.
 *
 * The nonce is per-grid-rebuild — increments when a token's grid is
 * rebuilt/shifted, making prior CLOIDs stale (so `cancel-all` for a token
 * uses the OLD nonce's CLOIDs).
 */

import { keccak256, encodeAbiParameters, type Address } from 'viem';

export function gridCloid(
  strategy: Address,
  assetIndex: number,
  isBuy: boolean,
  levelIndex: number,
  nonce: number,
): bigint {
  const hash = keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint32' },
        { type: 'bool' },
        { type: 'uint32' },
        { type: 'uint32' },
      ],
      [strategy, assetIndex, isBuy, levelIndex, nonce],
    ),
  );
  // Take the high 16 bytes as uint128.
  // keccak256 already returns `0x${string}` — no cast needed.
  const top16 = hash.slice(0, 2 + 32); // '0x' + 32 hex chars = 16 bytes
  return BigInt(top16);
}
