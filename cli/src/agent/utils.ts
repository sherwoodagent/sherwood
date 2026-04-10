/** Clamp a number between min and max (default [-1, 1]). */
export function clamp(v: number, min: number = -1, max: number = 1): number {
  return Math.min(max, Math.max(min, v));
}
