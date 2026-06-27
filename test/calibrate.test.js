// Tests — confidence calibration ported onto the flat-hypothesis model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exportDataset, calibrate, applyCalibration, reliabilityBins, MIN_SAMPLES,
} from '../src/core/calibrate.js';

const mkSnap = (hyps) => ({ id: 's', timestamp: 0, hypotheses: hyps });
const mkHyp = (conf, outcome, extra = {}) => ({
  bias: 'bull', stage: 'awaiting2°', confidence: { value: conf, components: {} }, outcome, ...extra,
});

// ── exportDataset ─────────────────────────────────────────────────────────────

test('exportDataset: hit→1, miss→0, expired→0, pending/null skipped', () => {
  const ds = exportDataset([mkSnap([
    mkHyp(0.7, 'hit'),
    mkHyp(0.6, 'miss'),
    mkHyp(0.5, 'expired'),
    mkHyp(0.4, 'pending'),
    mkHyp(0.3, null),
  ])]);
  assert.equal(ds.length, 3, 'only resolved hypotheses count');
  assert.deepEqual(ds.map(d => d.y).sort(), [0, 0, 1]);
});

test('exportDataset: drops non-finite confidence', () => {
  const ds = exportDataset([mkSnap([{ bias: 'bull', stage: 'x', confidence: {}, outcome: 'hit' }])]);
  assert.equal(ds.length, 0);
});

test('exportDataset: handles empty / missing gracefully', () => {
  assert.equal(exportDataset([]).length, 0);
  assert.equal(exportDataset(null).length, 0);
  assert.equal(exportDataset([{ }]).length, 0);
});

// ── calibrate (safety rail) ───────────────────────────────────────────────────

test('calibrate: below MIN_SAMPLES → identity model (fitted=false)', () => {
  const ds = Array.from({ length: MIN_SAMPLES - 1 }, () => ({ x: 0.6, y: 1 }));
  const m = calibrate(ds);
  assert.equal(m.fitted, false);
  assert.equal(m.a, 1);
  assert.equal(m.b, 0);
});

test('applyCalibration: not fitted → returns raw unchanged', () => {
  const m = calibrate([{ x: 0.6, y: 1 }]); // too few
  assert.equal(applyCalibration(m, 0.6), 0.6);
  assert.equal(applyCalibration(m, 0.42), 0.42);
});

test('applyCalibration: clamps output to [0,1]', () => {
  const m = { fitted: true, a: 5, b: 10 };
  const v = applyCalibration(m, 0.99);
  assert.ok(v >= 0 && v <= 1);
});

// ── calibrate (fitted behaviour) ──────────────────────────────────────────────

test('calibrate: fits when raw confidence over-states hit rate', () => {
  // Synthetic: model says 0.8 but true hit rate is ~0.4 → calibration should
  // map 0.8 downward.
  const data = [];
  for (let i = 0; i < 100; i++) data.push({ x: 0.8, y: i < 40 ? 1 : 0 });
  const m = calibrate(data);
  assert.equal(m.fitted, true);
  const cal = applyCalibration(m, 0.8);
  assert.ok(cal < 0.8, `expected calibrated < 0.8, got ${cal}`);
  assert.ok(Math.abs(cal - 0.4) < 0.15, `expected ≈0.4, got ${cal}`);
});

// ── reliabilityBins ───────────────────────────────────────────────────────────

test('reliabilityBins: buckets by raw value and reports empirical hit rate', () => {
  const data = [
    { x: 0.05, y: 0 }, { x: 0.05, y: 0 },
    { x: 0.85, y: 1 }, { x: 0.85, y: 1 }, { x: 0.85, y: 0 },
  ];
  const bins = reliabilityBins(data, 10);
  assert.equal(bins[0].n, 2);
  assert.equal(bins[0].hitRate, 0);
  assert.equal(bins[8].n, 3);
  assert.ok(Math.abs(bins[8].hitRate - 2 / 3) < 1e-9);
  assert.equal(bins[5].hitRate, null, 'empty bucket → null');
});
