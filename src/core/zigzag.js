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
 * Percentage/ATR reversal zigzag.
 *
 * Each pivot carries `close` (candle close at that bar) and `atr` (ATR value
 * at that bar) so downstream break-tests can use ATR-local tolerances (§A.7).
 *
 * @returns {Array<{index,time,price,type,close,atr,tentative?}>}
 */
export function zigzag(candles, opts = {}) {
  const n = candles.length;
  if (n < 2) return [];

  // Build ATR series when using ATR-scaled threshold (the default).
  const atrPeriod = opts.atrPeriod ?? 14;
  let atrVals = null;
  let thresh;

  if (opts.pct != null) {
    const pct = opts.pct;
    thresh = (price) => price * pct;
  } else {
    const mult = opts.atrMult ?? 3;
    atrVals = atr(candles, atrPeriod);
    thresh = (price, index) => {
      const v = atrVals[index];
      return Number.isFinite(v) ? v * mult : price * 0.03;
    };
  }

  const pivotAtr = (idx) =>
    atrVals && Number.isFinite(atrVals[idx]) ? atrVals[idx] : null;

  const pivots = [];
  let dir = 0;
  let extIdx = 0;
  let extPrice = candles[0].close;

  const push = (idx, type) => {
    pivots.push({
      index: idx,
      time:  candles[idx].time,
      price: extPrice,
      type,
      close: candles[idx].close,
      atr:   pivotAtr(idx),
    });
  };

  for (let i = 1; i < n; i++) {
    const c = candles[i];
    if (dir === 1) {
      if (c.high >= extPrice) { extPrice = c.high; extIdx = i; }
      else if (extPrice - c.low >= thresh(extPrice, extIdx)) {
        push(extIdx, 'H');
        dir = -1; extPrice = c.low; extIdx = i;
      }
    } else if (dir === -1) {
      if (c.low <= extPrice) { extPrice = c.low; extIdx = i; }
      else if (c.high - extPrice >= thresh(extPrice, extIdx)) {
        push(extIdx, 'L');
        dir = 1; extPrice = c.high; extIdx = i;
      }
    } else {
      const base = candles[0];
      if (c.high - base.low >= thresh(c.high, i)) {
        pivots.push({
          index: 0, time: base.time, price: base.low, type: 'L',
          close: base.close, atr: pivotAtr(0),
        });
        dir = 1; extPrice = c.high; extIdx = i;
      } else if (base.high - c.low >= thresh(base.high, 0)) {
        pivots.push({
          index: 0, time: base.time, price: base.high, type: 'H',
          close: base.close, atr: pivotAtr(0),
        });
        dir = -1; extPrice = c.low; extIdx = i;
      }
    }
  }

  if (dir !== 0) {
    extPrice = dir === 1 ? candles[extIdx].high : candles[extIdx].low;
    pivots.push({
      index: extIdx, time: candles[extIdx].time, price: extPrice,
      type: dir === 1 ? 'H' : 'L',
      close: candles[extIdx].close,
      atr:   pivotAtr(extIdx),
      tentative: true,
    });
  }
  return pivots;
}

/**
 * Structural fatigue score for a pivot sequence: 0 = fresh momentum, 1 = exhausted.
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
  return Math.max(0, Math.min(1, 1.5 - ratio));
}

/** Signed lengths of each leg between consecutive pivots (price terms). */
export function legs(pivots) {
  const out = [];
  for (let i = 1; i < pivots.length; i++) {
    out.push({
      from: pivots[i - 1],
      to:   pivots[i],
      length: pivots[i].price - pivots[i - 1].price,
      up: pivots[i].price > pivots[i - 1].price,
    });
  }
  return out;
}
