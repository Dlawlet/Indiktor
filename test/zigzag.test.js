import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zigzag, atr, legs } from '../src/core/zigzag.js';

// Line candles: high=low=open=close=price, time = sequential.
const line = (prices) =>
  prices.map((p, i) => ({ time: 1000 + i, open: p, high: p, low: p, close: p, volume: 1 }));

test('zigzag finds alternating H/L pivots with a 10% threshold', () => {
  const c = line([100, 110, 120, 130, 120, 110, 130, 160, 200, 180, 150]);
  const piv = zigzag(c, { pct: 0.1 });

  assert.deepEqual(piv.map(p => p.type), ['L', 'H', 'L', 'H', 'L']);
  assert.deepEqual(piv.map(p => p.price), [100, 130, 110, 200, 150]);
  // only the trailing live extreme is tentative
  assert.equal(piv.at(-1).tentative, true);
  assert.ok(piv.slice(0, -1).every(p => !p.tentative));
});

test('zigzag ignores moves below threshold (noise)', () => {
  // wiggles under 10% then one clean 20% drop
  const c = line([100, 103, 99, 102, 101, 80]);
  const piv = zigzag(c, { pct: 0.1 });
  assert.deepEqual(piv.map(p => p.type), ['H', 'L']);
  assert.equal(piv[0].price, 100);
  assert.equal(piv[1].price, 80);
});

test('zigzag returns empty for <2 candles', () => {
  assert.deepEqual(zigzag(line([100]), { pct: 0.1 }), []);
});

test('atr is positive once warmed up', () => {
  const c = line([10, 12, 11, 13, 12, 14, 13, 15, 14, 16, 15, 17, 16, 18, 17]);
  const a = atr(c, 14);
  assert.ok(Number.isNaN(a[12]));
  assert.ok(a[14] > 0);
});

test('legs reports signed lengths and direction', () => {
  const c = line([100, 130, 110]);
  const piv = zigzag(c, { pct: 0.1 });
  const l = legs(piv);
  assert.equal(l[0].length, 30);
  assert.equal(l[0].up, true);
  assert.equal(l[1].length, -20);
  assert.equal(l[1].up, false);
});
