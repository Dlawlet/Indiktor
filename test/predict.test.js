// Tests — Phase 6a predictive engine.
// Validates band inversion (P.2), TP measured move (P.3), and hypothesis
// enumeration (P.1).  All arithmetic is checked against manual derivations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateHypotheses, invertBands, measuredMoveTP, predictiveConfidence } from '../src/core/predict.js';

// Minimal pivot factory
const pv = (price, type = 'L') => ({ price, type, time: price, close: price, atr: null, index: 0 });

// ── invertBands — formingC ────────────────────────────────────────────────────
// Bull flat reference: O=100, A=150, B=106 (rB=0.88 → regular/contracting branch)
// legA=50, branch=['regular','contracting']

const O_ref  = pv(100, 'L');
const A_ref  = pv(150, 'H');
const B_ref  = pv(106, 'L');  // rB = (150-106)/50 = 0.88 → regular/contracting
const preO_r = pv(200, 'H');  // 1° above A ✓

function makeHypFormingC(preO = preO_r) {
  const legA = 50;
  const rB   = (A_ref.price - B_ref.price) / legA;  // 0.88
  return {
    stage: 'formingC', bias: 'bull',
    typeBranch: ['regular', 'contracting'],
    anchor: { preO, O: O_ref, A: A_ref, B: B_ref, C: null },
    legA, rB,
  };
}

test('invertBands formingC: regular completion zone contains C at pC=0.12', () => {
  // C = A + pC·legA = 150 + 0.12·50 = 156
  // regular pC band [0, 0.30] → C_pC ∈ [150, 165]
  // regular lenC band [0.85, 1.30] → C_lenC = 106 + [0.85,1.30]·50 = [148.5, 171]
  // intersection: [max(150,148.5), min(165,171)] = [150, 165]
  const hyp   = makeHypFormingC();
  const zones = invertBands(hyp);
  const [lo, hi] = zones.completion.regular;
  const C_at_012 = 150 + 0.12 * 50;  // 156
  assert.ok(C_at_012 >= lo && C_at_012 <= hi,
    `C=156 (pC=0.12) should be inside regular zone [${lo.toFixed(1)}, ${hi.toFixed(1)}]`);
});

test('invertBands formingC: C at pC=0.80 is outside regular zone', () => {
  // C = 150 + 0.80·50 = 190 — well beyond the 0.30 upper band edge
  const hyp   = makeHypFormingC();
  const zones = invertBands(hyp);
  const [lo, hi] = zones.completion.regular;
  const C_at_080 = 150 + 0.80 * 50;  // 190
  assert.ok(C_at_080 > hi,
    `C=190 (pC=0.80) should be outside regular zone [${lo.toFixed(1)}, ${hi.toFixed(1)}]`);
});

test('invertBands formingC: contracting zone is below A (C does not break A)', () => {
  // contracting pC band [-0.60, 0.00] → C < A for bull flat
  const hyp   = makeHypFormingC();
  const zones = invertBands(hyp);
  const zone  = zones.completion.contracting;
  assert.ok(zone !== null, 'contracting zone should exist');
  assert.ok(zone[1] <= A_ref.price,
    `contracting zone hi=${zone[1].toFixed(1)} should be ≤ A=${A_ref.price}`);
});

test('invertBands formingC: regular zone is at or above A (C breaks A)', () => {
  // regular pC band [0.00, 0.30] → C >= A for bull flat
  const hyp   = makeHypFormingC();
  const zones = invertBands(hyp);
  const zone  = zones.completion.regular;
  assert.ok(zone !== null, 'regular zone should exist');
  assert.ok(zone[0] >= A_ref.price,
    `regular zone lo=${zone[0].toFixed(1)} should be ≥ A=${A_ref.price}`);
});

test('invertBands formingC: hard_1deg = preO price', () => {
  const zones = invertBands(makeHypFormingC());
  assert.equal(zones.invalidation.hard_1deg, preO_r.price);
});

test('invertBands formingC: soft invalidation contains all completion zones', () => {
  const hyp   = makeHypFormingC();
  const zones = invertBands(hyp);
  const [sLo, sHi] = zones.invalidation.soft;
  for (const [lo, hi] of Object.values(zones.completion).filter(Boolean)) {
    assert.ok(lo >= sLo, `completion lo=${lo} should be ≥ soft lo=${sLo}`);
    assert.ok(hi <= sHi, `completion hi=${hi} should be ≤ soft hi=${sHi}`);
  }
});

// ── invertBands — formingB ────────────────────────────────────────────────────

test('invertBands formingB: has completion zones for all 4 types', () => {
  const hyp = {
    stage: 'formingB', bias: 'bull',
    anchor: { preO: preO_r, O: O_ref, A: A_ref, B: null, C: null },
    legA: 50,
  };
  const zones = invertBands(hyp);
  assert.ok(zones.completion.regular,     'missing regular');
  assert.ok(zones.completion.contracting, 'missing contracting');
  assert.ok(zones.completion.running,     'missing running');
  assert.ok(zones.completion.expanding,   'missing expanding');
});

test('invertBands formingB: rB>1 types (running/expanding) have B breaking O', () => {
  // For bull flat, B breaks O means B < O = 100
  const hyp = {
    stage: 'formingB', bias: 'bull',
    anchor: { preO: preO_r, O: O_ref, A: A_ref, B: null, C: null },
    legA: 50,
  };
  const zones = invertBands(hyp);
  // running: rB ∈ [1.00,1.40] → B = A - rB·legA ∈ [A-1.40·50, A-1.00·50] = [80, 100]
  const [rLo, rHi] = zones.completion.running;
  assert.ok(rHi <= O_ref.price, `running B zone hi=${rHi} should be ≤ O=${O_ref.price}`);
  assert.ok(rLo < O_ref.price,  `running B zone lo=${rLo} should be < O`);
});

// ── measuredMoveTP ────────────────────────────────────────────────────────────

test('measuredMoveTP: bull flat — TP is below B', () => {
  // legA=50 (bull, bearish continuation), preO=200, O=100, B=106
  // amplitude = |200-100| = 100; dir = -1; TP = 106 - 1.0·100 = 6
  const hyp = makeHypFormingC();
  const [lo, hi] = measuredMoveTP(hyp);
  assert.ok(lo < B_ref.price, `TP lo=${lo} should be below B=${B_ref.price}`);
  assert.ok(hi === B_ref.price, `TP hi should equal B=${B_ref.price}`);
  assert.ok(Math.abs(lo - 6) < 1e-9, `TP should equal 6, got ${lo}`);
});

test('measuredMoveTP: bear flat — TP is above B', () => {
  // Bear flat: O=200(H), A=90(L), B=160(H), legA=-110
  // preO=50(L); amplitude=|50-200|=150; dir=+1; TP = 160 + 1.0·150 = 310
  const hyp = {
    stage: 'formingC', bias: 'bear',
    typeBranch: ['regular', 'contracting'],
    anchor: { preO: pv(50,'L'), O: pv(200,'H'), A: pv(90,'L'), B: pv(160,'H'), C: null },
    legA: -110, rB: (90-160)/(-110),
  };
  const [lo, hi] = measuredMoveTP(hyp);
  assert.ok(hi > pv(160).price, `TP hi=${hi} should be above B=160`);
  assert.ok(lo === 160,         `TP lo should equal B=160`);
  assert.ok(Math.abs(hi - 310) < 1e-9, `TP should equal 310, got ${hi}`);
});

test('measuredMoveTP: falls back to |legA| when preO absent', () => {
  const hyp = {
    stage: 'formingC', bias: 'bull',
    typeBranch: ['regular', 'contracting'],
    anchor: { preO: null, O: O_ref, A: A_ref, B: B_ref, C: null },
    legA: 50, rB: 0.88,
  };
  const tp = measuredMoveTP(hyp);
  assert.ok(tp !== null, 'should return a range even without preO');
  const [lo, hi] = tp;
  assert.ok(hi === B_ref.price, 'hi should be B');
  assert.ok(lo < hi, 'TP should be below B for bull flat');
});

// ── enumerateHypotheses ───────────────────────────────────────────────────────

test('enumerateHypotheses: detects formingB when only O and A are confirmed', () => {
  const pivots = [pv(100,'L'), pv(150,'H')];
  const hyps = enumerateHypotheses(pivots, 120);
  assert.ok(hyps.length > 0, 'should find at least one hypothesis');
  assert.ok(hyps.some(h => h.stage === 'formingB'), 'should include formingB');
});

test('enumerateHypotheses: detects formingC when O, A, B are confirmed', () => {
  const pivots = [pv(200,'H'), pv(100,'L'), pv(150,'H'), pv(106,'L')];
  const hyps   = enumerateHypotheses(pivots, 155);
  assert.ok(hyps.some(h => h.stage === 'formingC'), 'should find formingC');
});

test('enumerateHypotheses: formingC typeBranch is [regular, contracting] when rB≤1', () => {
  // rB = (150-106)/50 = 0.88 ≤ 1
  const pivots = [pv(200,'H'), pv(100,'L'), pv(150,'H'), pv(106,'L')];
  const hyps   = enumerateHypotheses(pivots, 155);
  const fc     = hyps.find(h => h.stage === 'formingC');
  assert.ok(fc, 'formingC hypothesis required');
  assert.deepEqual(fc.typeBranch.slice().sort(), ['contracting', 'regular']);
});

test('enumerateHypotheses: formingC typeBranch is [running, expanding] when rB>1', () => {
  // O=100, A=150, B=90 → rB=(150-90)/50=1.20 > 1
  const pivots = [pv(200,'H'), pv(100,'L'), pv(150,'H'), pv(90,'L')];
  const hyps   = enumerateHypotheses(pivots, 155);
  const fc     = hyps.find(h => h.stage === 'formingC');
  assert.ok(fc, 'formingC hypothesis required');
  assert.deepEqual(fc.typeBranch.slice().sort(), ['expanding', 'running']);
});

test('enumerateHypotheses: detects awaiting2° when O,A,B,C all confirmed', () => {
  const pivots = [pv(200,'H'), pv(100,'L'), pv(150,'H'), pv(106,'L'), pv(158,'H')];
  const hyps   = enumerateHypotheses(pivots, 130);
  assert.ok(hyps.some(h => h.stage === 'awaiting2°'), 'should find awaiting2°');
});

test('enumerateHypotheses: each hypothesis has zones and confidence', () => {
  const pivots = [pv(200,'H'), pv(100,'L'), pv(150,'H'), pv(106,'L')];
  const hyps   = enumerateHypotheses(pivots, 155);
  for (const h of hyps) {
    assert.ok(h.zones,      `${h.stage}: missing zones`);
    assert.ok(h.confidence, `${h.stage}: missing confidence`);
    assert.ok(h.confidence.value >= 0 && h.confidence.value <= 1,
      `${h.stage}: confidence.value out of [0,1]`);
  }
});

test('enumerateHypotheses: bear flat detected (legA<0)', () => {
  // Bear flat: O=200(H), A=90(L), B=160(H) → legA=-110 (bear)
  const pivots = [pv(50,'L'), pv(200,'H'), pv(90,'L'), pv(160,'H')];
  const hyps   = enumerateHypotheses(pivots, 100);
  const fc     = hyps.find(h => h.stage === 'formingC');
  assert.ok(fc,             'formingC should be found');
  assert.equal(fc.bias, 'bear');
  assert.ok(fc.legA < 0,   'legA should be negative for bear flat');
});

// ── predictiveConfidence ──────────────────────────────────────────────────────

test('predictiveConfidence: formingC > formingB (more confirmed pivots = higher confidence)', () => {
  const hypB = {
    stage: 'formingB', bias: 'bull',
    anchor: { preO: preO_r, O: O_ref, A: A_ref, B: null, C: null },
    legA: 50, rB: null, typeBranch: null,
  };
  const hypC = makeHypFormingC();
  const confB = predictiveConfidence(hypB).value;
  const confC = predictiveConfidence(hypC).value;
  assert.ok(confC > confB,
    `formingC (${confC.toFixed(3)}) should have higher confidence than formingB (${confB.toFixed(3)})`);
});

test('predictiveConfidence: all 4 components present in output', () => {
  const conf = predictiveConfidence(makeHypFormingC());
  assert.ok('stage_maturity'      in conf.components, 'missing stage_maturity');
  assert.ok('partial_band_fit'    in conf.components, 'missing partial_band_fit');
  assert.ok('channel_cleanliness' in conf.components, 'missing channel_cleanliness');
  assert.ok('fractal_consistency' in conf.components, 'missing fractal_consistency');
});
