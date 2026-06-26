// Fractal / multi-timeframe layer: run the wave engine independently on each
// timeframe, then measure how well the timeframes agree. Cross-timeframe
// alignment is itself one of the strongest confidence signals in Elliott work.

import { zigzag } from './zigzag.js';
import { analyze } from './elliott.js';
import { rankScenarios, directionalLean } from './scoring.js';
import { enrichScenarios } from './targets.js';

// Note: Binance has no native 10m candle (5m -> 15m -> 30m -> 1h). We use 15m as
// the lowest degree; resample from 5m in data.js if a true 10m is ever needed.
// Higher timeframes carry more weight — they dominate the fractal structure.
export const TIMEFRAMES = [
  { id: '15m', interval: '15m', limit: 1000, atrMult: 3, weight: 1 },
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
  const agreeWeight = byTf
    .filter((t) => t.lean.net !== 0 && Math.sign(t.lean.net) === Math.sign(weightedNet || 1))
    .reduce((s, t) => s + t.weight, 0);
  const agreement = wsum ? agreeWeight / wsum : 0;

  const side = dir === 'up' ? 'bullish' : 'bearish';
  const label = Math.abs(weightedNet) < 0.1
    ? 'mixed / transitional'
    : agreement >= 0.7 ? `aligned ${side}` : `leaning ${side}`;

  return { weightedNet, dir, agreement, label, byTf };
}
