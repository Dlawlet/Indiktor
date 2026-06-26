// Fractal / multi-timeframe layer: run the wave engine independently on each
// timeframe, then measure how well the timeframes agree. Cross-timeframe
// alignment is itself one of the strongest confidence signals in Elliott work.

import { zigzag } from './zigzag.js';
import { analyze } from './elliott.js';
import { rankScenarios, directionalLean } from './scoring.js';
import { enrichScenarios } from './targets.js';

// Higher timeframes carry more weight — they dominate the fractal structure.
// 1m gets lower weight (0.5) since micro structure is noisier; 1000 candles ≈ 16.7 hours.
export const TIMEFRAMES = [
  { id: '1m', interval: '1m', limit: 1000, atrMult: 3, weight: 0.5 },
  { id: '1h', interval: '1h', limit: 1000, atrMult: 3, weight: 2 },
  { id: '4h', interval: '4h', limit: 1000, atrMult: 3, weight: 3 },
  { id: '1d', interval: '1d', limit: 1000, atrMult: 3, weight: 4 },
];

/** Run the full engine chain on one timeframe's candles. */
export function runTimeframe(candles, { atrMult = 3, atrPeriod = 14 } = {}) {
  const pivots = zigzag(candles, { atrMult, atrPeriod });
  const price = candles.length ? candles[candles.length - 1].close : null;
  const structuralLevels = pivots
    .filter((p) => !p.tentative)
    .slice(-14)
    .map((p) => ({ price: p.price, source: 'swing', weight: 1.5 }));
  const ranked = enrichScenarios(rankScenarios(analyze(pivots)), { price, structuralLevels });
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
