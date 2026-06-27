// Tests — path-aware, per-hypothesis, expiry-aware snapshot evaluation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  takeSnapshot, classifyHypothesisPath, evaluateSnapshotPath, computeMetrics,
} from '../src/core/snapshot.js';

// Bull flat: TP zone below B (continuation is bearish); hard_1deg above (kills if price rises).
const bullHyp = {
  bias: 'bull', stage: 'awaiting2°',
  zones: { tp: [80, 100], invalidation: { hard_1deg: 200 } },
  confidence: { value: 0.70, components: {} },
};
// Bear flat: TP zone above B (continuation is bullish); hard_1deg below.
const bearHyp = {
  bias: 'bear', stage: 'awaiting2°',
  zones: { tp: [180, 220], invalidation: { hard_1deg: 50 } },
  confidence: { value: 0.60, components: {} },
};

// candle times are unix SECONDS; snapshot timestamps are ms.
const C = (t, low, high) => ({ time: t, open: (low + high) / 2, close: (low + high) / 2, high, low });

// ── classifyHypothesisPath (first touch) ──────────────────────────────────────

test('classifyHypothesisPath: candle enters TP zone → hit', () => {
  const out = classifyHypothesisPath(bullHyp, [C(10, 120, 130), C(20, 88, 96)]);
  assert.equal(out, 'hit');
});

test('classifyHypothesisPath: candle crosses hard invalidation → miss', () => {
  // bull: high > 200 → miss
  const out = classifyHypothesisPath(bullHyp, [C(10, 150, 160), C(20, 195, 210)]);
  assert.equal(out, 'miss');
});

test('classifyHypothesisPath: first touch wins (TP before inval)', () => {
  const out = classifyHypothesisPath(bullHyp, [C(10, 90, 99), C(20, 195, 210)]);
  assert.equal(out, 'hit', 'TP touched on first candle, before the later invalidation');
});

test('classifyHypothesisPath: single candle straddles both → miss (conservative)', () => {
  // huge bar: low into TP (≤100) and high above hard (>200)
  const out = classifyHypothesisPath(bullHyp, [C(10, 90, 210)]);
  assert.equal(out, 'miss');
});

test('classifyHypothesisPath: neither touched → pending', () => {
  const out = classifyHypothesisPath(bullHyp, [C(10, 120, 140), C(20, 130, 150)]);
  assert.equal(out, 'pending');
});

// ── evaluateSnapshotPath (per-hypothesis + headline + time filter) ─────────────

test('evaluateSnapshotPath: stores per-hypothesis outcomes; headline = primary', () => {
  const snap = takeSnapshot([bullHyp, bearHyp], 120, { timestamp: 1_000_000 });
  // candles AFTER snapshot (sec*1000 > 1_000_000 → time > 1000s)
  const candles = [C(2000, 88, 96), C(2100, 205, 215)];
  const res = evaluateSnapshotPath(snap, candles, { now: 1_000_000 });
  assert.equal(res.hypotheses[0].outcome, 'hit',  'bull TP [80,100] touched');
  assert.equal(res.hypotheses[1].outcome, 'hit',  'bear TP [180,220] touched');
  assert.equal(res.outcome, 'hit', 'headline = primary (index 0)');
});

test('evaluateSnapshotPath: ignores candles at/before snapshot time', () => {
  const snap = takeSnapshot([bullHyp], 120, { timestamp: 5_000_000 }); // = 5000s
  // candle at 4000s (before) tags TP but must be ignored; later candle stays pending
  const candles = [C(4000, 80, 100), C(6000, 120, 140)];
  const res = evaluateSnapshotPath(snap, candles, { now: 5_000_000 });
  assert.equal(res.hypotheses[0].outcome, 'pending');
});

test('evaluateSnapshotPath: primary miss even if secondary hits (no any-hit-wins)', () => {
  const snap = takeSnapshot([bullHyp, bearHyp], 120, { timestamp: 1_000_000 });
  const candles = [C(2000, 195, 210)]; // bull: high>200 → miss; bear TP[180,220] → hit
  const res = evaluateSnapshotPath(snap, candles, { now: 1_000_000 });
  assert.equal(res.hypotheses[0].outcome, 'miss');
  assert.equal(res.hypotheses[1].outcome, 'hit');
  assert.equal(res.outcome, 'miss', 'headline tracks the primary, not "any hit"');
});

test('evaluateSnapshotPath: pending past horizon → expired', () => {
  const snap = takeSnapshot([bullHyp], 120, { timestamp: 0 });
  const candles = [C(2000, 120, 140)]; // never touches
  const res = evaluateSnapshotPath(snap, candles, { now: 1e12, horizonMs: 1000 });
  assert.equal(res.hypotheses[0].outcome, 'expired');
  assert.equal(res.outcome, 'expired');
});

test('evaluateSnapshotPath: expired counts against accuracy via computeMetrics', () => {
  const e = { ...takeSnapshot([bullHyp], 120, { timestamp: 0 }), outcome: 'expired' };
  const h = { ...takeSnapshot([bullHyp], 120, { timestamp: 0 }), outcome: 'hit' };
  const m = computeMetrics([e, h]);
  assert.ok(Math.abs(m.accuracy - 0.5) < 1e-9, `expected 0.5, got ${m.accuracy}`);
});
