// Swing/pivot reduction: collapse candles into a zigzag of significant turning
// points. This is the structural backbone everything in the wave engine reads.

/** Wilder's ATR. Returns an array aligned to `candles` (NaN until warmed up). */
export function atr(candles, period = 14) {
  const n = candles.length;
  const tr = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (i === 0) { tr[i] = c.high - c.low; continue; }
    const pc = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  const out = new Array(n).fill(NaN);
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < n; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

/**
 * Build a per-candle minimum-reversal distance (in price).
 * - `{ pct }`            -> fixed fraction of price (e.g. 0.05 = 5%)
 * - `{ atrMult, atrPeriod }` -> ATR-scaled (default 3x ATR-14), with a 3% fallback
 */
function makeThreshold(candles, opts) {
  if (opts.pct != null) {
    const pct = opts.pct;
    return (price) => price * pct;
  }
  const period = opts.atrPeriod ?? 14;
  const mult = opts.atrMult ?? 3;
  const a = atr(candles, period);
  return (price, index) => {
    const v = a[index];
    return Number.isFinite(v) ? v * mult : price * 0.03;
  };
}

/**
 * Percentage/ATR reversal zigzag.
 * @returns {Array<{index:number,time:number,price:number,type:'H'|'L',tentative?:boolean}>}
 *   The final element is the current (unconfirmed) leg extreme, marked
 *   `tentative` — the wave engine needs it to reason about the live wave.
 */
export function zigzag(candles, opts = {}) {
  const n = candles.length;
  if (n < 2) return [];
  const thresh = makeThreshold(candles, opts);

  const pivots = [];
  let dir = 0;        // 1 = up-leg (seeking a high), -1 = down-leg (seeking a low)
  let extIdx = 0;
  let extPrice = candles[0].close;

  for (let i = 1; i < n; i++) {
    const c = candles[i];
    if (dir === 1) {
      if (c.high >= extPrice) { extPrice = c.high; extIdx = i; }
      else if (extPrice - c.low >= thresh(extPrice, extIdx)) {
        pivots.push({ index: extIdx, time: candles[extIdx].time, price: extPrice, type: 'H' });
        dir = -1; extPrice = c.low; extIdx = i;
      }
    } else if (dir === -1) {
      if (c.low <= extPrice) { extPrice = c.low; extIdx = i; }
      else if (c.high - extPrice >= thresh(extPrice, extIdx)) {
        pivots.push({ index: extIdx, time: candles[extIdx].time, price: extPrice, type: 'L' });
        dir = 1; extPrice = c.high; extIdx = i;
      }
    } else {
      const base = candles[0];
      if (c.high - base.low >= thresh(c.high, i)) {
        pivots.push({ index: 0, time: base.time, price: base.low, type: 'L' });
        dir = 1; extPrice = c.high; extIdx = i;
      } else if (base.high - c.low >= thresh(base.high, 0)) {
        pivots.push({ index: 0, time: base.time, price: base.high, type: 'H' });
        dir = -1; extPrice = c.low; extIdx = i;
      }
    }
  }

  if (dir !== 0) {
    pivots.push({
      index: extIdx, time: candles[extIdx].time, price: extPrice,
      type: dir === 1 ? 'H' : 'L', tentative: true,
    });
  }
  return pivots;
}

/**
 * Structural fatigue score for a pivot sequence: 0 = fresh momentum, 1 = exhausted.
 *
 * Measures how the last leg's amplitude compares to the first of the recent `nLegs`
 * swings. Progressively shorter swings signal that the current wave is losing thrust
 * and is likely completing. Used to adjust scenario probabilities — completion patterns
 * (flat-C, impulse-complete) get a boost when fatigue is high.
 *
 *   ratio < 1 → shrinking legs (fatigue rising)  → score > 0.5
 *   ratio = 1 → equal legs (neutral)              → score = 0.5
 *   ratio > 1 → expanding legs (fresh momentum)  → score < 0.5
 */
export function fatigue(pivots, nLegs = 4) {
  if (pivots.length < 3) return 0.5;
  const recent = pivots.slice(-(nLegs + 1));
  const sizes  = [];
  for (let i = 1; i < recent.length; i++) {
    sizes.push(Math.abs(recent[i].price - recent[i - 1].price));
  }
  if (sizes.length < 2 || !sizes[0]) return 0.5;
  const ratio = sizes[sizes.length - 1] / sizes[0];
  // ratio=0.5 → score=1.0, ratio=1.0 → score=0.5, ratio=1.5 → score=0.0
  return Math.max(0, Math.min(1, 1.5 - ratio));
}

/** Signed lengths of each leg between consecutive pivots (price terms). */
export function legs(pivots) {
  const out = [];
  for (let i = 1; i < pivots.length; i++) {
    out.push({
      from: pivots[i - 1],
      to: pivots[i],
      length: pivots[i].price - pivots[i - 1].price,
      up: pivots[i].price > pivots[i - 1].price,
    });
  }
  return out;
}
