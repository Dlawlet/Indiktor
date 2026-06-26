import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTimeframe, alignTimeframes } from '../src/core/multiframe.js';

const line = (prices) =>
  prices.map((p, i) => ({ time: 1000 + i, open: p, high: p, low: p, close: p, volume: 1 }));

test('runTimeframe returns pivots, ranked scenarios and a lean', () => {
  const candles = line([100, 110, 120, 130, 120, 110, 130, 160, 200, 180, 150]);
  const r = runTimeframe(candles); // <14 candles -> ATR warmup falls back to 3% threshold
  assert.ok(Array.isArray(r.pivots) && r.pivots.length > 0);
  assert.ok(Array.isArray(r.ranked));
  assert.ok(['bullish', 'bearish', 'mixed'].includes(r.lean.label));
  assert.equal(r.price, 150);
});

test('alignTimeframes: agreeing timeframes produce an aligned label', () => {
  const a = alignTimeframes([
    { id: '15m', weight: 1, lean: { net: 0.4, label: 'bullish' } },
    { id: '1h', weight: 2, lean: { net: 0.5, label: 'bullish' } },
    { id: '4h', weight: 3, lean: { net: 0.3, label: 'bullish' } },
    { id: '1d', weight: 4, lean: { net: 0.6, label: 'bullish' } },
  ]);
  assert.ok(a.weightedNet > 0);
  assert.equal(a.dir, 'up');
  assert.equal(a.agreement, 1);
  assert.equal(a.label, 'aligned bullish');
});

test('alignTimeframes: conflicting timeframes lower agreement', () => {
  const a = alignTimeframes([
    { id: '15m', weight: 1, lean: { net: 0.5, label: 'bullish' } },
    { id: '1h', weight: 2, lean: { net: -0.5, label: 'bearish' } },
    { id: '4h', weight: 3, lean: { net: 0.4, label: 'bullish' } },
    { id: '1d', weight: 4, lean: { net: -0.4, label: 'bearish' } },
  ]);
  // higher TFs (4h up weight3, 1d down weight4) -> net slightly bearish, low agreement
  assert.ok(a.agreement < 0.7);
  assert.ok(a.label.includes('leaning') || a.label.includes('mixed'));
});

test('alignTimeframes: near-zero net is transitional', () => {
  const a = alignTimeframes([
    { id: '1h', weight: 2, lean: { net: 0.05, label: 'mixed' } },
    { id: '1d', weight: 4, lean: { net: -0.02, label: 'mixed' } },
  ]);
  assert.equal(a.label, 'mixed / transitional');
});
