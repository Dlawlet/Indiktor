import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exportDataset, calibrate, applyCalibration, reliabilityBins, MIN_SAMPLES,
} from '../src/feedback/calibrate.js';

// Build a stored record with given (probability, outcome) pairs.
function recordWith(pairs) {
  return {
    id: 'r',
    snapshot: {
      id: 'r',
      scenarios: pairs.map((p, i) => ({
        id: `sc${i}`,
        features: { prior: 0.5, guideline: 0.5, pattern: 'impulse', bias: 'up', targetRatios: [1], invalidation: 0, probability: p.prob },
      })),
    },
    outcomes: Object.fromEntries(pairs.map((p, i) => [`sc${i}`, { outcome: p.outcome, resolver: p.resolver ?? 'auto' }])),
  };
}

test('exportDataset emits resolved scenarios only, labeling outcomes 1/0', () => {
  const rec = recordWith([
    { prob: 0.7, outcome: 'target-hit' },
    { prob: 0.3, outcome: 'invalidated' },
    { prob: 0.5, outcome: 'pending' }, // skipped — no ground truth
  ]);
  const ds = exportDataset([rec]);
  assert.equal(ds.length, 2);
  assert.equal(ds.find((d) => d.scenarioId === 'sc0').outcome, 1);
  assert.equal(ds.find((d) => d.scenarioId === 'sc1').outcome, 0);
  assert.ok(ds.every((d) => d.features && typeof d.features.probability === 'number'));
});

test('applyCalibration returns raw unchanged below MIN_SAMPLES', () => {
  const rec = recordWith([
    { prob: 0.8, outcome: 'target-hit' },
    { prob: 0.2, outcome: 'invalidated' },
  ]);
  const ds = exportDataset([rec]);
  assert.ok(ds.length < MIN_SAMPLES);
  const model = calibrate(ds);
  assert.equal(model.fitted, false);
  for (const raw of [0.1, 0.37, 0.5, 0.9]) {
    assert.equal(applyCalibration(model, raw), raw);
  }
});

test('applyCalibration with no model returns raw', () => {
  assert.equal(applyCalibration(null, 0.42), 0.42);
  assert.equal(applyCalibration(undefined, 0.0), 0.0);
});

test('calibrate is monotonic on a trivial separable dataset', () => {
  // >= MIN_SAMPLES examples where high prob -> hit, low prob -> miss.
  const pairs = [];
  for (let i = 0; i < MIN_SAMPLES + 10; i++) {
    pairs.push(i % 2 === 0
      ? { prob: 0.85, outcome: 'target-hit' }
      : { prob: 0.15, outcome: 'invalidated' });
  }
  const model = calibrate(exportDataset([recordWith(pairs)]));
  assert.equal(model.fitted, true);

  // Calibrated curve must be non-decreasing in raw probability.
  let prev = -Infinity;
  for (const x of [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
    const c = applyCalibration(model, x);
    assert.ok(c >= prev - 1e-9, `monotonic broke at ${x}: ${c} < ${prev}`);
    assert.ok(c >= 0 && c <= 1, `out of range at ${x}: ${c}`);
    prev = c;
  }
  // Separable data should pull a high raw above a low raw.
  assert.ok(applyCalibration(model, 0.85) > applyCalibration(model, 0.15));
});

test('reliabilityBins buckets data and reports per-bucket hit rate', () => {
  const bins = reliabilityBins(
    [{ x: 0.05, y: 0 }, { x: 0.95, y: 1 }, { x: 0.92, y: 1 }],
    10,
  );
  assert.equal(bins.length, 10);
  assert.equal(bins[0].hitRate, 0);   // [0,0.1) -> one miss
  assert.equal(bins[9].hitRate, 1);   // [0.9,1] -> two hits
  assert.equal(bins[5].hitRate, null); // empty bucket
});
