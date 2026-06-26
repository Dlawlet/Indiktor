// Fibonacci retracement / extension / projection helpers used for wave targets
// and for scoring how "Fibonacci-clean" an actual wave is.

export const RETRACEMENT_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786, 0.886];
export const EXTENSION_RATIOS = [1.0, 1.272, 1.382, 1.618, 2.0, 2.618];

/**
 * Retracement levels of the move start -> end.
 * ratio 0 => end, ratio 1 => start.
 */
export function retracements(start, end, ratios = RETRACEMENT_RATIOS) {
  const diff = end - start;
  return ratios.map(r => ({ ratio: r, price: end - diff * r }));
}

/**
 * Extension levels of the move start -> end measured from `start`.
 * ratio 1 => end, ratio 1.618 => start + 1.618*(end-start).
 */
export function extensions(start, end, ratios = EXTENSION_RATIOS) {
  const diff = end - start;
  return ratios.map(r => ({ ratio: r, price: start + diff * r }));
}

/**
 * Project the length of leg a->b from a new origin c.
 * e.g. a wave-3 target = endOfWave2 + ratio * lengthOfWave1.
 */
export function projectFrom(a, b, c, ratios = EXTENSION_RATIOS) {
  const len = b - a;
  return ratios.map(r => ({ ratio: r, price: c + len * r }));
}

/**
 * The fraction of the move start->end that `price` retraced.
 * e.g. ratioOf(100, 200, 161.8) ~= 0.382.
 */
export function ratioOf(start, end, price) {
  const diff = end - start;
  if (diff === 0) return 0;
  return (end - price) / diff;
}

/**
 * How close `actualRatio` is to the nearest of `targets`, as a 0..1 score
 * (1 = exact, 0 = `tol` or further away). Used to reward Fib-clean waves.
 */
export function fibCleanliness(actualRatio, targets, tol = 0.12) {
  let best = Infinity;
  for (const t of targets) best = Math.min(best, Math.abs(actualRatio - t));
  return Math.max(0, 1 - best / tol);
}
