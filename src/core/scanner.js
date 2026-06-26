// Historical flat-pattern scanner — runs in both browser and Node.
// Slides over ALL consecutive triplets of confirmed pivots to find the
// full 4-pattern flat family (regular, running, expanding, contracting)
// in the full history.
import { zigzag } from './zigzag.js';

const FLAT_NAMES = {
  regular: 'Regular Flat',
  running: 'Running Flat',
  expanding: 'Expanding Flat',
  contracting: 'Contracting Flat',
};

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

const IDEAL_BRET = {
  regular: 0.85,
  contracting: 0.45,
  running: 1.12,
  expanding: 1.45,
};

const BRET_TOL = {
  regular: 0.15,
  contracting: 0.20,
  running: 0.18,
  expanding: 0.55,
};

/**
 * Confidence score for a flat candidate using shape quality + context coherence.
 *
 * @param {object} args
 * @param {object} args.classified  Output of classifyFlatPattern
 * @param {object|null} args.origin Pivot before A-start (if available)
 * @param {object} args.aStart      A-start pivot
 * @param {object} args.bEnd        B-end pivot
 * @param {object|null} args.next   Pivot after B-end (if available)
 * @param {number} args.spanCandles A-start to B-end span in candles
 * @param {number} args.minSpan     Minimum structural span used by scanner
 * @returns {number} confidence in [0, 1]
 */
export function scoreFlatCandidate({
  classified,
  origin,
  aStart,
  bEnd,
  next,
  spanCandles,
  minSpan,
}) {
  const { type, dirA, bRet } = classified;

  const ratioIdeal = IDEAL_BRET[type] ?? 1.0;
  const ratioTol = BRET_TOL[type] ?? 0.25;
  const ratioScore = clamp01(1 - Math.abs(bRet - ratioIdeal) / ratioTol);

  // Structure score saturates around 2x minSpan, but does not punish valid near-threshold waves too hard.
  const structureScore = clamp01(spanCandles / (Math.max(1, minSpan) * 2));

  const preDir = origin ? sign(aStart.price - origin.price) : 0;
  const postDir = next ? sign(next.price - bEnd.price) : 0;

  // Running/expanding prefer trend continuity into A; regular/contracting prefer corrective A.
  const expectedPre = (type === 'running' || type === 'expanding') ? dirA : -dirA;
  const preScore = origin ? (preDir === expectedPre ? 1 : 0.25) : 0.55;

  // Flat-family expectation for C start after B: move in A's direction.
  const postScore = next ? (postDir === dirA ? 1 : 0.2) : 0.6;

  const typeWeight = {
    regular: 0.92,
    running: 0.95,
    expanding: 0.84,
    contracting: 0.82,
  }[type] ?? 0.85;

  const raw = (0.45 * ratioScore) + (0.20 * structureScore) + (0.20 * preScore) + (0.15 * postScore);
  return +(clamp01(raw * typeWeight).toFixed(3));
}

/**
 * Classify a 3-pivot flat candidate into one of 4 flat-family variants.
 *
 * @param {object} a   A-start pivot
 * @param {object} b   A-end pivot
 * @param {object} c   B-end pivot
 * @returns {null|{type:string,dirA:number,bRet:number,aLen:number,bLen:number,name:string,market:string,bias:string}}
 */
export function classifyFlatPattern(a, b, c) {
  const dirA = Math.sign(b.price - a.price);
  if (!dirA) return null;

  const aLen = Math.abs(b.price - a.price);
  const bLen = Math.abs(c.price - b.price);
  if (!aLen) return null;

  const bRet = bLen / aLen;
  const bExceedsAStart = dirA > 0 ? c.price < a.price : c.price > a.price;

  let type = null;
  if (!bExceedsAStart) {
    if (bRet >= 0.25 && bRet < 0.65) type = 'contracting';
    else if (bRet >= 0.70 && bRet < 1.0) type = 'regular';
  } else {
    // Split strong-B structures into running vs expanding using the common
    // 1.236 threshold from flat-family guidelines.
    if (bRet >= 1.0 && bRet < 1.236) type = 'running';
    else if (bRet >= 1.236 && bRet <= 3.0) type = 'expanding';
  }

  if (!type) return null;
  const market = dirA > 0 ? 'bull' : 'bear';
  return {
    type,
    dirA,
    bRet: +bRet.toFixed(3),
    aLen,
    bLen,
    market,
    bias: dirA > 0 ? 'up' : 'down',
    name: `${market.toUpperCase()} ${FLAT_NAMES[type]}`,
  };
}

/**
 * @param {Array} candles   Ascending {time,open,high,low,close} candles
 * @param {object} opts
 * @param {number} opts.atrMult    Zigzag threshold (default 3). Use 2× the live value for history.
 * @param {number} opts.atrPeriod  ATR period (default 14)
 * @param {number} opts.bRetMinReg Minimum B/A ratio for regular flat (default 0.70)
 * @param {number} opts.minSpan    Min candles between A-start and B-end (default 20).
 *                                 Filters out spike-to-spike false detections — only
 *                                 structural moves (multi-candle waves) qualify.
 * @returns {Array<{type,name,market,bias,dirA,bRet,aLen,bLen,aStart,aEnd,bEnd}>}
 */
export function scanHistoricalFlats(candles, opts = {}) {
  const {
    atrMult    = 3,
    atrPeriod  = 14,
    bRetMinReg = 0.70,
    minSpan    = 20,   // structural filter: A+B must span at least this many candles
    minConfidence = 0.62,
    maxASpan = 9,
    maxBSpan = 5,
    maxOriginSpan = 6,
    topPerBEnd = 2,
  } = opts;

  // Time → index map for O(1) span lookup
  const timeToIdx = new Map(candles.map((c, i) => [c.time, i]));
  const nearestIdx = (t) => {
    if (timeToIdx.has(t)) return timeToIdx.get(t);
    // fallback: first candle at or after t
    for (let i = 0; i < candles.length; i++) if (candles[i].time >= t) return i;
    return candles.length - 1;
  };

  const bestByKey = new Map();

  const pivots = zigzag(candles, { atrMult, atrPeriod });
  const conf   = pivots.filter(p => !p.tentative);

  for (let bEndIdx = 2; bEndIdx < conf.length; bEndIdx++) {
    const bEnd = conf[bEndIdx];
    const next = conf[bEndIdx + 1] ?? null;

    for (let bSpan = 1; bSpan <= maxBSpan; bSpan++) {
      const aEndIdx = bEndIdx - bSpan;
      if (aEndIdx < 1) break;
      const aEnd = conf[aEndIdx];
      if (aEnd.type === bEnd.type) continue;

      for (let aSpan = 1; aSpan <= maxASpan; aSpan++) {
        const aStartIdx = aEndIdx - aSpan;
        if (aStartIdx < 0) break;
        const aStart = conf[aStartIdx];
        if (aStart.type !== bEnd.type) continue;

        const spanCandles = nearestIdx(bEnd.time) - nearestIdx(aStart.time);
        if (spanCandles < minSpan) continue;

        const classified = classifyFlatPattern(aStart, aEnd, bEnd);
        if (!classified) continue;
        if (classified.type === 'regular' && classified.bRet < bRetMinReg) continue;

        // Test multiple origins before A-start and keep the best coherent context.
        let best = null;
        const from = Math.max(0, aStartIdx - maxOriginSpan);
        for (let oIdx = aStartIdx - 1; oIdx >= from; oIdx--) {
          const origin = conf[oIdx];
          const confidence = scoreFlatCandidate({
            classified,
            origin,
            aStart,
            bEnd,
            next,
            spanCandles,
            minSpan,
          });
          if (!best || confidence > best.confidence) {
            best = { origin, confidence };
          }
        }
        if (!best) {
          const confidence = scoreFlatCandidate({
            classified,
            origin: null,
            aStart,
            bEnd,
            next,
            spanCandles,
            minSpan,
          });
          best = { origin: null, confidence };
        }

        if (best.confidence < minConfidence) continue;

        const entry = {
          ...classified,
          aStart,
          aEnd,
          bEnd,
          origin: best.origin,
          next,
          spanCandles,
          confidence: best.confidence,
        };

        const key = `${bEnd.time}:${classified.type}:${classified.bias}`;
        const prev = bestByKey.get(key);
        if (!prev || entry.confidence > prev.confidence) bestByKey.set(key, entry);
      }
    }
  }

  const all = [...bestByKey.values()].sort((a, b) => b.confidence - a.confidence);
  const byEndCount = new Map();
  const kept = [];
  for (const p of all) {
    const k = p.bEnd.time;
    const count = byEndCount.get(k) ?? 0;
    if (count >= topPerBEnd) continue;
    byEndCount.set(k, count + 1);
    kept.push(p);
  }

  return kept;
}
