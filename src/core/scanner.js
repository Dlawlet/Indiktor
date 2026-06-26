// Historical flat-pattern scanner — runs in both browser and Node.
// Slides over ALL consecutive triplets of confirmed pivots to find every
// regular-flat and running-flat structure in the full history.
import { zigzag } from './zigzag.js';

/**
 * @param {Array} candles   Ascending {time,open,high,low,close} candles
 * @param {object} opts
 * @param {number} opts.atrMult    Zigzag threshold (default 3). Use 2× the live value for history.
 * @param {number} opts.atrPeriod  ATR period (default 14)
 * @param {number} opts.bRetMinReg Minimum B/A ratio for regular flat (default 0.70)
 * @param {number} opts.minSpan    Min candles between A-start and B-end (default 20).
 *                                 Filters out spike-to-spike false detections — only
 *                                 structural moves (multi-candle waves) qualify.
 * @returns {Array<{type,dirA,bRet,aLen,bLen,aStart,aEnd,bEnd}>}
 */
export function scanHistoricalFlats(candles, opts = {}) {
  const {
    atrMult    = 3,
    atrPeriod  = 14,
    bRetMinReg = 0.70,
    minSpan    = 20,   // structural filter: A+B must span at least this many candles
  } = opts;

  // Time → index map for O(1) span lookup
  const timeToIdx = new Map(candles.map((c, i) => [c.time, i]));
  const nearestIdx = (t) => {
    if (timeToIdx.has(t)) return timeToIdx.get(t);
    // fallback: first candle at or after t
    for (let i = 0; i < candles.length; i++) if (candles[i].time >= t) return i;
    return candles.length - 1;
  };

  const results = [];
  const seen    = new Set();

  const pivots = zigzag(candles, { atrMult, atrPeriod });
  const conf   = pivots.filter(p => !p.tentative);

  for (let i = 2; i < conf.length; i++) {
    const [a, b, c] = [conf[i - 2], conf[i - 1], conf[i]];
    const key = `${a.time}:${b.time}:${c.time}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Structural filter: skip if the whole A+B pattern fits within too few candles.
    // Consecutive zigzag spikes (noise) are typically 2-8 candles apart.
    // Real structural waves span 20+ candles.
    const spanCandles = nearestIdx(c.time) - nearestIdx(a.time);
    if (spanCandles < minSpan) continue;

    const dirA = Math.sign(b.price - a.price);
    if (!dirA) continue;
    const aLen = Math.abs(b.price - a.price);
    const bLen = Math.abs(c.price - b.price);
    if (!aLen) continue;
    const bRet = bLen / aLen;

    const bExceedsAStart = dirA > 0 ? c.price < a.price : c.price > a.price;

    let type = null;
    if (!bExceedsAStart && bRet >= bRetMinReg && bRet < 1.0) type = 'regular';
    else if (bExceedsAStart && bRet >= 1.0 && bRet <= 3.0)  type = 'running';
    if (!type) continue;

    results.push({ type, dirA, bRet: +bRet.toFixed(3), aLen, bLen, aStart: a, aEnd: b, bEnd: c });
  }

  return results;
}
