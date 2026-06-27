// Tests — Phase 6e: snapshot.js
// Validates capture, evaluation, feedback, metrics, and historical replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  takeSnapshot, evaluateSnapshot, recordFeedback,
  computeMetrics, replayHistory,
} from '../src/core/snapshot.js';

// ── Hypothesis fixtures ───────────────────────────────────────────────────────
//
// Bull flat: TP = [6, 106] (bearish continuation — TP goes DOWN below B=106)
//   hard_1deg = 200 (above A=150; price crossing above kills the hypothesis)
//
// Bear flat: TP = [180, 220] (bullish continuation — TP goes UP above B=180)
//   hard_1deg = 50 (below A=90; price crossing below kills the hypothesis)

const bullHyp = {
  bias: 'bull', stage: 'awaiting2°',
  zones: {
    tp:           [6, 106],
    invalidation: { hard_1deg: 200 },
  },
  confidence: { value: 0.70, components: {} },
};

const bearHyp = {
  bias: 'bear', stage: 'awaiting2°',
  zones: {
    tp:           [180, 220],
    invalidation: { hard_1deg: 50 },
  },
  confidence: { value: 0.65, components: {} },
};

// ── takeSnapshot ──────────────────────────────────────────────────────────────

test('takeSnapshot: returns snapshot with required fields', () => {
  const snap = takeSnapshot([bullHyp], 120);
  assert.ok(typeof snap.id        === 'string',  'id must be a string');
  assert.ok(typeof snap.timestamp === 'number',  'timestamp must be a number');
  assert.equal(snap.livePrice, 120,              'livePrice must match');
  assert.equal(snap.outcome,   null,             'outcome starts as null');
  assert.equal(snap.feedback,  null,             'feedback starts as null');
  assert.equal(snap.hypotheses.length, 1,        'one hypothesis stored');
});

test('takeSnapshot: accepts custom id and timestamp', () => {
  const snap = takeSnapshot([bullHyp], 120, { id: 'test_42', timestamp: 1000000 });
  assert.equal(snap.id,        'test_42');
  assert.equal(snap.timestamp, 1000000);
});

test('takeSnapshot: hypothesis list is shallow-cloned (mutation-safe)', () => {
  const hyps = [{ ...bullHyp }];
  const snap = takeSnapshot(hyps, 120);
  hyps[0].bias = 'mutated';
  assert.equal(snap.hypotheses[0].bias, 'bull', 'snapshot must be independent of original');
});

// ── evaluateSnapshot — bull flat ──────────────────────────────────────────────

test('evaluateSnapshot bull: price inside TP zone → hit', () => {
  // TP = [6, 106]; price=80 → 6 ≤ 80 ≤ 106 → hit
  const snap = takeSnapshot([bullHyp], 120);
  const res  = evaluateSnapshot(snap, 80);
  assert.equal(res.outcome, 'hit');
});

test('evaluateSnapshot bull: price at TP boundary (= tpHi) → hit', () => {
  const snap = takeSnapshot([bullHyp], 120);
  assert.equal(evaluateSnapshot(snap, 106).outcome, 'hit');
});

test('evaluateSnapshot bull: price above hard_1deg → miss', () => {
  // hard_1deg = 200; price=210 > 200 → miss (bull flat invalidated)
  const snap = takeSnapshot([bullHyp], 120);
  assert.equal(evaluateSnapshot(snap, 210).outcome, 'miss');
});

test('evaluateSnapshot bull: price between TP and invalidation → pending', () => {
  // price=130 is above tpHi=106 (not in TP) and below inval=200 (not invalidated)
  const snap = takeSnapshot([bullHyp], 120);
  assert.equal(evaluateSnapshot(snap, 130).outcome, 'pending');
});

// ── evaluateSnapshot — bear flat ─────────────────────────────────────────────

test('evaluateSnapshot bear: price inside TP zone → hit', () => {
  // TP = [180, 220]; price=200 → 180 ≤ 200 ≤ 220 → hit
  const snap = takeSnapshot([bearHyp], 170);
  assert.equal(evaluateSnapshot(snap, 200).outcome, 'hit');
});

test('evaluateSnapshot bear: price below hard_1deg → miss', () => {
  // hard_1deg = 50; price=40 < 50 → miss (bear flat invalidated)
  const snap = takeSnapshot([bearHyp], 170);
  assert.equal(evaluateSnapshot(snap, 40).outcome, 'miss');
});

test('evaluateSnapshot bear: price between B and TP → pending', () => {
  // price=175 is below tpLo=180 (not in TP) and above inval=50 (not invalidated)
  const snap = takeSnapshot([bearHyp], 170);
  assert.equal(evaluateSnapshot(snap, 175).outcome, 'pending');
});

// ── evaluateSnapshot — multiple hypotheses ────────────────────────────────────

test('evaluateSnapshot: any hit → outcome is hit (not miss)', () => {
  // bullHyp hit at 80; bearHyp invalidated at 40 → but bull wins with 'hit'
  const snap = takeSnapshot([bullHyp, bearHyp], 120);
  assert.equal(evaluateSnapshot(snap, 80).outcome, 'hit');
});

test('evaluateSnapshot: bull invalidated but bear TP hit → overall hit', () => {
  // price=210: bull hard_1deg=200 crossed → bull miss
  //            but bear TP=[180,220] → 210 ∈ [180,220] → bear HIT
  // any hit wins → 'hit'
  const snap = takeSnapshot([bullHyp, bearHyp], 120);
  assert.equal(evaluateSnapshot(snap, 210).outcome, 'hit');
});

test('evaluateSnapshot: all miss (both invalidated) → outcome is miss', () => {
  // Create two hyps that are both invalidated by the same price
  const h1 = { ...bullHyp };  // invalidated if price > 200
  const h2 = { bias: 'bull', zones: { tp: [10, 50], invalidation: { hard_1deg: 150 } }, confidence: { value: 0.5, components: {} } };
  // price=220: h1 invalidated (>200), h2 invalidated (>150) → all miss → miss
  const snap = takeSnapshot([h1, h2], 120);
  assert.equal(evaluateSnapshot(snap, 220).outcome, 'miss');
});

test('evaluateSnapshot: null currentPrice → outcome unchanged (null)', () => {
  const snap = takeSnapshot([bullHyp], 120);
  const res  = evaluateSnapshot(snap, null);
  assert.equal(res.outcome, null);
});

// ── recordFeedback ────────────────────────────────────────────────────────────

test('recordFeedback: sets outcome and feedback', () => {
  const snap = takeSnapshot([bullHyp], 120);
  const fb   = recordFeedback(snap, 'hit', 'price tagged TP exactly');
  assert.equal(fb.outcome,          'hit');
  assert.equal(fb.feedback.outcome, 'hit');
  assert.equal(fb.feedback.notes,   'price tagged TP exactly');
  assert.ok(typeof fb.feedback.timestamp === 'number');
});

test('recordFeedback: does not mutate original snapshot', () => {
  const snap = takeSnapshot([bullHyp], 120);
  recordFeedback(snap, 'miss');
  assert.equal(snap.outcome, null, 'original snapshot must not be mutated');
});

// ── computeMetrics ────────────────────────────────────────────────────────────

test('computeMetrics: empty input → all zeros, accuracy null', () => {
  const m = computeMetrics([]);
  assert.equal(m.total,    0);
  assert.equal(m.hit,      0);
  assert.equal(m.miss,     0);
  assert.equal(m.pending,  0);
  assert.equal(m.accuracy, null);
});

test('computeMetrics: only pending → accuracy null', () => {
  const snap = takeSnapshot([bullHyp], 120);  // outcome=null
  const m = computeMetrics([snap]);
  assert.equal(m.total,    1);
  assert.equal(m.pending,  1);
  assert.equal(m.accuracy, null);
});

test('computeMetrics: 2 hit, 1 miss → accuracy = 2/3', () => {
  const h  = { ...takeSnapshot([bullHyp], 110), outcome: 'hit'  };
  const h2 = { ...takeSnapshot([bullHyp], 115), outcome: 'hit'  };
  const m_ = { ...takeSnapshot([bullHyp], 120), outcome: 'miss' };
  const metrics = computeMetrics([h, h2, m_]);
  assert.equal(metrics.total, 3);
  assert.equal(metrics.hit,   2);
  assert.equal(metrics.miss,  1);
  assert.ok(Math.abs(metrics.accuracy - 2/3) < 1e-9, `expected 2/3, got ${metrics.accuracy}`);
});

test('computeMetrics: expired counts in denominator', () => {
  const e = { ...takeSnapshot([bullHyp], 110), outcome: 'expired' };
  const h = { ...takeSnapshot([bullHyp], 115), outcome: 'hit'     };
  const m = computeMetrics([e, h]);
  // accuracy = 1 / (1 + 1) = 0.5
  assert.ok(Math.abs(m.accuracy - 0.5) < 1e-9, `expected 0.5, got ${m.accuracy}`);
});

// ── replayHistory ─────────────────────────────────────────────────────────────

test('replayHistory: evaluates each entry against its outcomePrice', () => {
  const s1 = takeSnapshot([bullHyp], 120);
  const s2 = takeSnapshot([bearHyp], 170);
  const results = replayHistory([
    { snapshot: s1, outcomePrice:  80 },  // bull hit
    { snapshot: s2, outcomePrice: 200 },  // bear hit
  ]);
  assert.equal(results[0].outcome, 'hit');
  assert.equal(results[1].outcome, 'hit');
});

test('replayHistory: null outcomePrice → outcome stays null', () => {
  const s = takeSnapshot([bullHyp], 120);
  const [res] = replayHistory([{ snapshot: s, outcomePrice: null }]);
  assert.equal(res.outcome, null);
});

test('replayHistory: historical replay → full classification (spec acceptance test)', () => {
  // Build a sequence: hit, miss, pending → accuracy = 1/2
  const s1 = takeSnapshot([bullHyp], 120);
  const s2 = takeSnapshot([bullHyp], 130);
  const s3 = takeSnapshot([bullHyp], 140);

  const evaluated = replayHistory([
    { snapshot: s1, outcomePrice:  80  },  // price in TP [6,106] → hit
    { snapshot: s2, outcomePrice: 210  },  // price > hard_1deg=200 → miss
    { snapshot: s3, outcomePrice: null },  // no price yet → pending
  ]);

  assert.equal(evaluated[0].outcome, 'hit');
  assert.equal(evaluated[1].outcome, 'miss');
  assert.equal(evaluated[2].outcome, null);

  const m = computeMetrics(evaluated);
  assert.equal(m.hit,  1);
  assert.equal(m.miss, 1);
  assert.equal(m.pending, 1);
  assert.ok(Math.abs(m.accuracy - 0.5) < 1e-9);
});
