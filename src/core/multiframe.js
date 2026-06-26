// Fractal / multi-timeframe layer: run the wave engine independently on each
// timeframe, then measure how well the timeframes agree. Cross-timeframe
// alignment is itself one of the strongest confidence signals in Elliott work.

import { zigzag, atr as computeAtr } from './zigzag.js';
import { analyze } from './elliott.js';
import { rankScenarios, directionalLean } from './scoring.js';
import { enrichScenarios } from './targets.js';

// Higher timeframes carry more weight — they dominate the fractal structure.
// 1m gets lower weight (0.5) since micro structure is noisier; 1000 candles ≈ 16.7 hours.
export const TIMEFRAMES = [
  { id: '1m',  interval: '1m',  limit: 1000, atrMult: 3, weight: 0.5 },
  { id: '15m', interval: '15m', limit: 1000, atrMult: 3, weight: 1 },
  { id: '1h',  interval: '1h',  limit: 1000, atrMult: 3, weight: 2 },
  { id: '4h',  interval: '4h',  limit: 1000, atrMult: 3, weight: 3 },
  { id: '1d',  interval: '1d',  limit: 1000, atrMult: 3, weight: 4 },
];

// Patterns where the channel (base trendline + parallel) is a structural constraint.
// Crossing the BASE line in the wrong direction breaks the pattern entirely.
// Running-flat and expanded-flat are excluded: their B wave intentionally exceeds
// the start, so a naive phase-check would fire false positives.
const CHANNEL_INVALIDATABLE = new Set(['wave-3', 'wave-5', 'zigzag-c', 'continuation', 'double-zigzag']);

/**
 * Returns false only after 2 consecutive candle closes have crossed the base
 * trendline. A single close below is often a wick fakeout; two back-to-back
 * closes confirm the channel break. Tolerance is ATR-normalized so narrow
 * channels aren't killed by normal volatility noise.
 */
function channelIntact(scenario, recentCandles, atr) {
  if (!CHANNEL_INVALIDATABLE.has(scenario.id)) return true;
  const ap = scenario.anchorPivots;
  if (!ap || ap.length < 3) return true;
  const [a, b, c] = ap.slice(-3);
  if (c.time <= a.time) return true;
  const slope  = (c.price - a.price) / (c.time - a.time);
  const lineAt = (t) => a.price + slope * (t - a.time);
  const offset = b.price - lineAt(b.time);
  if (Math.abs(offset) < 1e-8) return true;
  // Allow up to 0.5 ATR of noise beyond the base line (capped at 10% of channel)
  const tolerance = atr ? Math.min(0.10, (atr * 0.5) / Math.abs(offset)) : 0.05;
  const breakCount = recentCandles.filter(
    ({ close, time }) => (close - lineAt(time)) / offset < -tolerance,
  ).length;
  return breakCount < 2;
}

/**
 * Returns a probability multiplier (1.0–1.2) based on how many zigzag pivots
 * independently touch each channel trendline. A line through exactly 2 points
 * is always possible by definition; extra touches are genuine structural confirmation.
 * Classic rule: 2 touches on each side makes the channel high-confidence.
 */
function channelTouchQuality(scenario, zigzagPivots, atr) {
  if (!CHANNEL_INVALIDATABLE.has(scenario.id)) return 1.0;
  const ap = scenario.anchorPivots;
  if (!ap || ap.length < 3) return 1.0;
  const [a, b, c] = ap.slice(-3);
  if (c.time <= a.time) return 1.0;
  const slope  = (c.price - a.price) / (c.time - a.time);
  const lineAt = (t) => a.price + slope * (t - a.time);
  const offset = b.price - lineAt(b.time);
  if (Math.abs(offset) < 1e-8) return 1.0;
  const tol = atr ? atr * 0.5 : Math.abs(offset) * 0.15;
  const anchorTimes = new Set([a.time, b.time, c.time]);
  let baseTouches = 2, parallelTouches = 1; // A+C on base, B on parallel — guaranteed
  for (const p of zigzagPivots) {
    if (anchorTimes.has(p.time) || p.tentative || p.time < a.time) continue;
    const distBase = Math.abs(p.price - lineAt(p.time));
    const distPara = Math.abs(p.price - (lineAt(p.time) + offset));
    if (distBase <= tol) baseTouches++;
    else if (distPara <= tol) parallelTouches++;
  }
  // Second parallel touch confirms the channel is genuinely two-sided
  if (parallelTouches >= 2 && baseTouches >= 2) return 1.2;
  if (parallelTouches >= 2 || baseTouches >= 3) return 1.1;
  return 1.0;
}

/** Run the full engine chain on one timeframe's candles. */
export function runTimeframe(candles, { atrMult = 3, atrPeriod = 14 } = {}) {
  // Fine pass: short-term structure (the current active zigzag shown on chart)
  const pivots = zigzag(candles, { atrMult, atrPeriod });

  // Macro pass: 2.5× stricter threshold → only major structural pivots survive.
  // This allows the EW templates to see the large-degree wave shapes (running
  // flat, expanded flat, multi-month impulse) that the fine pass misses because
  // its slice(-3) / slice(-6) is buried in recent minor swings.
  const macroPivots = zigzag(candles, { atrMult: atrMult * 2.5, atrPeriod });
  const macroScenarios = rankScenarios(analyze(macroPivots))
    .map((s) => ({ ...s, degree: 'macro', probability: s.probability * 0.88 }));

  const price = candles.length ? candles[candles.length - 1].close : null;
  const atrArr = computeAtr(candles);
  const currentAtr = atrArr[atrArr.length - 1] || 0;
  const recentCandles = candles.slice(-3);
  const structuralLevels = pivots
    .filter((p) => !p.tentative)
    .slice(-14)
    .map((p) => ({ price: p.price, source: 'swing', weight: 1.5 }));

  // Merge both degree scenarios, sort by probability descending.
  // NOTE: each pass normalises its OWN pool independently, so the two probability
  // scales are not directly comparable after merging — we must re-normalise.
  const combined = [...rankScenarios(analyze(pivots)), ...macroScenarios]
    .sort((a, b) => b.probability - a.probability);

  // Deduplicate: same pattern + direction from two different degree passes is the
  // same read at two zoom levels, not independent evidence. First occurrence wins
  // (highest probability since the list is already sorted descending).
  const seenKeys = new Set();
  const deduped = combined.filter((s) => {
    const key = `${s.id}:${s.bias}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  // Remove any channel-aware scenario whose flag has already been broken: requires
  // 2 consecutive closes below the base trendline (ATR-normalized tolerance) so
  // single-candle wick pierces don't prematurely kill the scenario.
  const channelValid = deduped.filter((s) => channelIntact(s, recentCandles, currentAtr));

  // Boost scenarios whose channel has been confirmed by additional pivot touches
  // (beyond the guaranteed 2 base + 1 parallel). A well-touched channel earns
  // up to 20% more probability weight before the final renormalization.
  const touchScored = channelValid.map((s) => {
    const mult = channelTouchQuality(s, pivots, currentAtr);
    return mult === 1.0 ? s : { ...s, probability: s.probability * mult };
  });

  // Re-normalise across the unified pool so probabilities are comparable, then
  // apply a quality gate: a scenario must reach ≥ 65% of the top scenario's
  // share of the combined pool. Anything below that is noise relative to the
  // dominant read, not a genuine alternative.
  const totalP = touchScored.reduce((s, x) => s + x.probability, 0) || 1;
  const renormed = touchScored.map((s) => ({ ...s, probability: s.probability / totalP }));
  const maxP = renormed.length ? renormed[0].probability : 0;
  const gated = renormed.filter((s) => s.probability >= maxP * 0.65);

  const ranked = enrichScenarios(gated, { price, structuralLevels });
  const lean = directionalLean(ranked);
  return { pivots, ranked, lean, price };
}

/**
 * Aggregate per-timeframe leans into a weighted fractal read.
 * @param {Array<{id:string, weight:number, lean:{net:number,label:string}}>} byTf
 * @returns {{weightedNet:number, dir:'up'|'down', agreement:number, label:string, byTf:Array}}
 */
export function alignTimeframes(byTf) {
  const wsum = byTf.reduce((s, t) => s + t.weight, 0);
  const wnet = byTf.reduce((s, t) => s + t.weight * t.lean.net, 0);
  const weightedNet = wsum ? wnet / wsum : 0;
  const dir = weightedNet >= 0 ? 'up' : 'down';

  // share of (weighted) timeframes that agree with the net direction
  const netSign = weightedNet > 0 ? 1 : weightedNet < 0 ? -1 : 0;
  const agreeWeight = byTf
    .filter((t) => netSign !== 0 && Math.sign(t.lean.net) === netSign)
    .reduce((s, t) => s + t.weight, 0);
  const agreement = wsum ? agreeWeight / wsum : 0;

  const side = dir === 'up' ? 'bullish' : 'bearish';
  const label = Math.abs(weightedNet) < 0.1
    ? 'mixed / transitional'
    : agreement >= 0.7 ? `aligned ${side}` : `leaning ${side}`;

  return { weightedNet, dir, agreement, label, byTf };
}
