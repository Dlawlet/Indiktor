// Historical flat-pattern scanner — thin wrapper around zigzag + detectFlatPatterns.
// The full classification and scoring logic lives in flats.js (§A.4–A.9).
import { zigzag } from './zigzag.js';
import { detectFlatPatterns } from './flats.js';

/**
 * Scan a full OHLCV history for completed flat patterns.
 *
 * @param {Array}  candles  Ascending {time,open,high,low,close} candles
 * @param {object} opts
 * @param {number} opts.atrMult        Zigzag ATR threshold multiplier (default 3)
 * @param {number} opts.atrPeriod      ATR period (default 14)
 * @param {number} opts.minConfidence  Minimum confidence to keep a pattern (default 0.55)
 * @param {number} opts.maxLegSpan     Max pivot-gap per leg (default 3)
 * @param {object} opts.breakPolicy    Override delta/bigMult/tau for break tests
 * @returns {Array} detected flat patterns, sorted by confidence descending
 */
export function scanHistoricalFlats(candles, opts = {}) {
  const {
    atrMult       = 3,
    atrPeriod     = 14,
    minConfidence = 0.55,
    maxLegSpan    = 3,
    breakPolicy   = {},
  } = opts;

  const pivots    = zigzag(candles, { atrMult, atrPeriod });
  const confirmed = pivots.filter((p) => !p.tentative);

  const patterns = detectFlatPatterns(confirmed, {
    minConfidence,
    maxLegSpan,
    candles,
    breakPolicy,
  });

  return patterns.slice().sort((a, b) => b.confidence - a.confidence);
}
