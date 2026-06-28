// Tests — ④b geometry gate + fork rendering for ghost projection paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateGhostPaths } from '../src/core/ghost.js';

const candles = Array.from({ length: 12 }, (_, i) => ({
  time: (i + 1) * 1000, open: 100, high: 101, low: 99, close: 100,
}));

const anchor = (extra) => ({
  O: { price: 100, time: 1000 },
  A: { price: 150, time: 3000 },
  B: { price: 106, time: 5000 },
  C: null,
  ...extra,
});

test('④b gate: formingB (no typeBranch) → no projected paths', () => {
  const hyp = {
    stage: 'formingB', bias: 'bull', typeBranch: null,
    anchor: anchor({ B: null }),
    zones: { completion: { regular: [150, 165] }, invalidation: { soft: [80, 200] } },
  };
  assert.deepEqual(generateGhostPaths(hyp, 120, candles), []);
});

test('④b fork: formingC with 2-type branch → two distinct paths', () => {
  const hyp = {
    stage: 'formingC', bias: 'bull', rB: 0.88,
    typeBranch: ['regular', 'contracting'],
    anchor: anchor(),
    zones: { completion: { regular: [150, 165], contracting: [140, 150] }, tp: [6, 106] },
  };
  const paths = generateGhostPaths(hyp, 120, candles);
  assert.equal(paths.length, 2, 'one path per branch');
  assert.deepEqual(paths.map(p => p.type).sort(), ['contracting', 'regular']);
  for (const p of paths) {
    assert.ok(p.candles.length > 0, 'path has ghost candles');
    assert.ok(p.weight > 0 && p.weight <= 1, 'path carries a normalised weight');
    assert.ok(p.candles.every(c => c.high >= c.low), 'valid OHLC');
  }
  // Weights are normalised across the fork.
  const wsum = paths.reduce((s, p) => s + p.weight, 0);
  assert.ok(Math.abs(wsum - 1) < 1e-9, `weights sum to 1, got ${wsum}`);
});

test('④b: awaiting2° → single continuation path to TP', () => {
  const hyp = {
    stage: 'awaiting2°', bias: 'bull', typeBranch: ['regular', 'contracting'],
    anchor: anchor({ C: { price: 158, time: 7000 } }),
    zones: { tp: [6, 106] },
  };
  const paths = generateGhostPaths(hyp, 120, candles);
  assert.equal(paths.length, 1);
  assert.ok(paths[0].candles.length > 0);
  // Bull flat → bearish continuation: path should end near tp[0]=6 (below entry).
  const lastClose = paths[0].candles[paths[0].candles.length - 1].close;
  assert.ok(lastClose < 120, 'continuation heads down toward TP for a bull flat');
});

test('④b gate: no candles → no paths', () => {
  const hyp = { stage: 'formingC', bias: 'bull', rB: 0.88, typeBranch: ['regular'],
    anchor: anchor(), zones: { completion: { regular: [150, 165] }, tp: [6, 106] } };
  assert.deepEqual(generateGhostPaths(hyp, 120, []), []);
});
