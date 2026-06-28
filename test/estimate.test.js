// Tests — ① partial-pooling / shrinkage estimator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  observations, estimateFromObservations, estimateRates, bestParamPerSegment, SHRINK_K,
} from '../src/core/estimate.js';

// Build a snapshot with per-hypothesis outcomes.
const snap = (tf, paramHash, hyps) => ({
  tf, paramHash,
  hypotheses: hyps.map(([outcome, conf = 0.6, type = 'regular']) => ({
    outcome, confidence: { value: conf }, typeBranch: [type],
  })),
});

test('observations: flattens resolved hyps, skips pending/null', () => {
  const obs = observations([snap('1h', 'aaa', [['hit'], ['miss'], ['pending'], [null]])]);
  assert.equal(obs.length, 2);
  assert.deepEqual(obs.map(o => o.y).sort(), [0, 1]);
  assert.equal(obs[0].seg, '1h');
});

test('observations byType: segments by tf|type', () => {
  const obs = observations([snap('1h', 'aaa', [['hit', 0.6, 'running']])], { byType: true });
  assert.equal(obs[0].seg, '1h|running');
});

test('estimate: global rate = overall hit fraction', () => {
  const e = estimateRates([snap('1h', 'a', [['hit'], ['hit'], ['miss'], ['miss']])]);
  assert.ok(Math.abs(e.global.rate - 0.5) < 1e-9);
});

test('shrinkage: a thin segment is pulled toward the global rate', () => {
  // Global is strongly bullish; a 1-sample "miss" segment shouldn't read 0.
  const big = Array.from({ length: 40 }, () => snap('4h', 'g', [['hit']]));
  const thin = [snap('1m', 't', [['miss']])];
  const e = estimateFromObservations(observations([...big, ...thin]));
  const seg = e.segments['1m'];
  assert.equal(seg.raw, 0, 'raw rate of the single miss is 0');
  assert.ok(seg.rate > 0.5, `shrunk toward high global, got ${seg.rate.toFixed(3)}`);
  assert.ok(seg.rate < e.global.rate, 'but still below the global rate');
});

test('shrinkage: a well-sampled segment trusts its own rate', () => {
  const lots = Array.from({ length: 200 }, () => snap('1h', 'p', [['miss']]));
  const other = Array.from({ length: 50 }, () => snap('4h', 'q', [['hit']]));
  const e = estimateFromObservations(observations([...lots, ...other]));
  assert.ok(e.segments['1h'].rate < 0.1, `200 misses ⇒ low rate, got ${e.segments['1h'].rate.toFixed(3)}`);
});

test('bestParamPerSegment: picks the highest shrunk rate meeting minN', () => {
  const obs = [];
  for (let i = 0; i < 30; i++) obs.push({ seg: '1h', paramHash: 'good', y: 1 });
  for (let i = 0; i < 30; i++) obs.push({ seg: '1h', paramHash: 'bad',  y: 0 });
  obs.push({ seg: '1h', paramHash: 'fluke', y: 1 }); // 1 sample — should be ignored at minN=5
  const e = estimateFromObservations(obs);
  const best = bestParamPerSegment(e, { minN: 5 });
  assert.equal(best['1h'].paramHash, 'good');
});

test('estimate: empty input → null global, no segments', () => {
  const e = estimateRates([]);
  assert.equal(e.global.rate, null);
  assert.deepEqual(e.segments, {});
  assert.equal(e.k, SHRINK_K);
});
