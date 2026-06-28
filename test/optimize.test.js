// Tests — ① client sweep / optimiser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandGrid, sweepSeries, optimize } from '../src/core/optimize.js';

test('expandGrid: cartesian product', () => {
  const combos = expandGrid({ k: [2, 3], minConf: [0.5, 0.6] });
  assert.equal(combos.length, 4);
  assert.deepEqual(combos[0], { k: 2, minConf: 0.5 });
  assert.deepEqual(combos[3], { k: 3, minConf: 0.6 });
});

test('expandGrid: empty spec → single empty combo', () => {
  assert.deepEqual(expandGrid({}), [{}]);
});

// Synthetic zig-zag price series (alternating legs of varying size), enough to
// produce confirmed pivots and forward candles to resolve against.
function zigzagSeries(n = 400) {
  const c = [];
  let price = 1000;
  const legs = [60, -45, 55, -40, 70, -50, 48, -38];
  let li = 0, step = 0, len = Math.abs(legs[0]), dir = Math.sign(legs[0]), per = 8;
  for (let i = 0; i < n; i++) {
    price += (legs[li] / per) ;
    if (++step >= per) { step = 0; li = (li + 1) % legs.length; }
    const hi = price + 3, lo = price - 3;
    c.push({ time: (i + 1) * 3600, open: price, high: hi, low: lo, close: price });
  }
  return c;
}

test('sweepSeries: returns well-formed observations', () => {
  const candles = zigzagSeries();
  const obs = sweepSeries(candles, '1h', expandGrid({ k: [2, 3] }), { predFloor: 0 });
  assert.ok(Array.isArray(obs));
  for (const o of obs) {
    assert.equal(o.seg, '1h');
    assert.match(o.paramHash, /^[0-9a-f]{8}$/);
    assert.ok(o.y === 0 || o.y === 1, 'y is binary (pending excluded)');
  }
});

test('optimize: returns estimate + proposals of the right shape', () => {
  const series = [{ candles: zigzagSeries(), tf: '1h' }];
  const res = optimize(series, { k: [2, 3, 4] }, { predFloor: 0, minN: 1 });
  assert.equal(res.combos, 3);
  assert.equal(typeof res.nObs, 'number');
  assert.ok(res.estimate && 'global' in res.estimate);
  assert.equal(typeof res.proposals, 'object');
  // Every proposal (if any) carries a concrete param set with a k value.
  for (const p of Object.values(res.proposals)) {
    assert.ok(p.params && typeof p.params.k === 'number');
    assert.ok(p.rate >= 0 && p.rate <= 1);
  }
});

test('optimize: no series → empty result, no throw', () => {
  const res = optimize([], { k: [3] }, {});
  assert.equal(res.nObs, 0);
  assert.deepEqual(res.proposals, {});
});
