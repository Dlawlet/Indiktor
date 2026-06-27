// Tests — Phase 6e: timing.js
// Validates duration priors and soft confidence scoring for flat legs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingScore, withTiming } from '../src/core/timing.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// Bull flat with explicit candle indices:
//   O at bar 0, A at bar 50 → legA = 50 bars
//   B at bar 80             → legB = 30 bars, ratio = 0.60 ∈ [0.382, 1.618] ✓
//   C at bar 140            → legC = 60 bars, ratio = 1.20 ∈ [0.500, 2.000] ✓

const iv = (price, type, idx) =>
  ({ price, type, time: idx, close: price, atr: null, index: idx });

const O_ = iv(100, 'L',   0);
const A_ = iv(150, 'H',  50);
const B_ = iv(106, 'L',  80);
const C_ = iv(158, 'H', 140);

function mkHyp(stage, anchor = {}, confVal = 0.60) {
  const base = { O: O_, A: A_, B: B_, C: C_ };
  return {
    stage, bias: 'bull', legA: 50,
    anchor: { ...base, ...anchor },
    confidence: { value: confVal, components: {} },
  };
}

// ── timingScore — formingB ────────────────────────────────────────────────────

test('timingScore: no index data → returns 1.0 (neutral)', () => {
  const hyp = { stage: 'formingB', bias: 'bull', anchor: { O: { price: 100 }, A: { price: 150 } }, confidence: { value: 0.6, components: {} } };
  assert.equal(timingScore(hyp, 60), 1.0);
});

test('timingScore formingB: elapsed = legA duration → score = 1.0 (within window)', () => {
  // ratio = 50/50 = 1.0, which is inside [0.382, 1.618]
  const hyp = mkHyp('formingB', { C: null });
  assert.equal(timingScore(hyp, 100), 1.0);  // currentBar = A.index + legA = 50+50
});

test('timingScore formingB: elapsed = 0 bars → penalised (too short)', () => {
  // ratio = 0/50 = 0, below lo=0.382 → score < 1.0
  const hyp = mkHyp('formingB', { C: null });
  const s = timingScore(hyp, 50);  // currentBar = A.index → elapsed = 0
  assert.ok(s < 1.0, `expected penalty for 0-bar elapsed, got ${s}`);
  assert.ok(s >= 0.30, 'score must not go below FLOOR=0.30');
});

test('timingScore formingB: elapsed = 200 bars (4× legA) → penalised (too long)', () => {
  // ratio = 150/50 = 3.0, above hi=1.618 → decays
  const hyp = mkHyp('formingB', { C: null });
  const s = timingScore(hyp, 200);  // A.index=50, elapsed=150
  assert.ok(s < 1.0, `expected penalty for 3× elapsed, got ${s}`);
  assert.ok(s >= 0.30, 'score must not go below FLOOR=0.30');
});

test('timingScore formingB: no currentBar → returns 1.0 (neutral)', () => {
  const hyp = mkHyp('formingB', { C: null });
  assert.equal(timingScore(hyp, null), 1.0);
});

// ── timingScore — formingC ────────────────────────────────────────────────────

test('timingScore formingC: B duration in window, elapsed C=0 → penalised only on C', () => {
  // legB = 30 bars → ratio 0.60 ∈ [0.382,1.618] → bScore=1.0
  // elapsed since B = 0 → cScore penalised
  const hyp = mkHyp('formingC', { C: null });
  const s = timingScore(hyp, 80);  // currentBar = B.index → elapsed = 0
  // gm(1.0, penalty) where penalty < 1.0 → s < 1.0
  assert.ok(s < 1.0, `expected C-leg penalty, got ${s}`);
  assert.ok(s >= 0.30, 'score must not go below FLOOR');
});

test('timingScore formingC: B and C both in window → score = 1.0', () => {
  // legB=30 ratio=0.60 ✓; elapsed C = 80/50 = 1.6 ∈ [0.50, 2.00] ✓
  const hyp = mkHyp('formingC', { C: null });
  const s = timingScore(hyp, 160);  // B.index=80, elapsed = 80 → ratio = 1.6
  assert.equal(s, 1.0);
});

// ── timingScore — awaiting2° ──────────────────────────────────────────────────

test('timingScore awaiting2°: both legs in window → score = 1.0', () => {
  // legB=30/50=0.60 ✓; legC=60/50=1.20 ✓ → gm(1,1)=1.0
  const hyp = mkHyp('awaiting2°');
  assert.equal(timingScore(hyp), 1.0);
});

test('timingScore awaiting2°: legB too short (10 bars, ratio=0.20) → penalised', () => {
  const shortB = iv(106, 'L', 60);   // A=50, B=60 → legB=10, ratio=0.20
  const longC  = iv(158, 'H', 110);  // B=60, C=110 → legC=50, ratio=1.00 ✓
  const hyp = mkHyp('awaiting2°', { B: shortB, C: longC });
  const s = timingScore(hyp);
  assert.ok(s < 1.0, `expected penalty for short B, got ${s}`);
  assert.ok(s >= 0.30, 'must not go below FLOOR');
});

test('timingScore awaiting2°: legC too long (200 bars, ratio=4.0) → penalised', () => {
  const extC = iv(158, 'H', 280);  // B=80, C=280 → legC=200, ratio=4.0 > 2.0
  const hyp = mkHyp('awaiting2°', { C: extC });
  const s = timingScore(hyp);
  assert.ok(s < 1.0, `expected penalty for extended C, got ${s}`);
  assert.ok(s >= 0.30, 'must not go below FLOOR');
});

// ── withTiming ────────────────────────────────────────────────────────────────

test('withTiming: adds timing component to all hyps', () => {
  const hyps = [mkHyp('awaiting2°'), mkHyp('formingC', { C: null })];
  const enriched = withTiming(hyps);
  for (const h of enriched) {
    assert.ok('timing' in h.confidence.components, 'timing component must be set');
    assert.ok(h.confidence.components.timing >= 0.30);
    assert.ok(h.confidence.components.timing <= 1.00);
  }
});

test('withTiming: good timing → confidence unchanged or improved vs bad timing', () => {
  // Good hyp: awaiting2°, both legs in window
  const good = mkHyp('awaiting2°', {}, 0.60);
  // Bad hyp: formingB with elapsed=0 (too short)
  const bad  = mkHyp('formingB', { C: null }, 0.60);

  const [enrichedGood] = withTiming([good]);
  const [enrichedBad]  = withTiming([bad], 50);  // currentBar = A.index → elapsed=0

  assert.ok(enrichedGood.confidence.value >= enrichedBad.confidence.value,
    `good timing (${enrichedGood.confidence.value.toFixed(3)}) should be ≥ bad timing (${enrichedBad.confidence.value.toFixed(3)})`);
});

test('withTiming: idempotent when called twice with same currentBar', () => {
  const hyp = mkHyp('awaiting2°', {}, 0.60);
  const [once]  = withTiming([hyp], 200);
  const [twice] = withTiming([once], 200);
  assert.ok(Math.abs(once.confidence.value - twice.confidence.value) < 1e-9,
    'calling withTiming twice with same bar should not change confidence');
});

test('withTiming: confidence never exceeds 1.0', () => {
  const hyp = mkHyp('awaiting2°', {}, 0.99);  // near max
  const [e] = withTiming([hyp]);
  assert.ok(e.confidence.value <= 1.0, 'confidence must not exceed 1.0');
});
