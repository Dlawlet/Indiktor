// Tests — Phase 6a/6b predictive engine.
// Validates band inversion (P.2), TP measured move (P.3), hypothesis
// enumeration (P.1), merge + beam (P.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enumerateHypotheses, invertBands, measuredMoveTP, predictiveConfidence,
  mergeOverlapping, beam, rankAndBeam,
} from '../src/core/predict.js';

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

test('predictiveConfidence: awaiting2° uses full 3-ratio bandFit (higher than rB-only)', () => {
  // O=100,A=150,B=106,C=158 → regular flat, rB=0.88, pC=0.16, lenC≈1.04 (near ideal)
  const hyp2 = {
    stage: 'awaiting2°', bias: 'bull',
    typeBranch: ['regular', 'contracting'],
    anchor: { preO: pv(200,'H'), O: pv(100,'L'), A: pv(150,'H'), B: pv(106,'L'), C: pv(158,'H') },
    legA: 50, rB: 0.88,
  };
  const hypC = makeHypFormingC();
  const conf2  = predictiveConfidence(hyp2).value;
  const confC  = predictiveConfidence(hypC).value;
  // awaiting2° stage_maturity (0.85) × full bandFit > formingC (0.65) × rB-only bandFit
  assert.ok(conf2 > confC,
    `awaiting2° (${conf2.toFixed(3)}) should outrank formingC (${confC.toFixed(3)})`);
});

// ── Phase 6b: beam + merge ────────────────────────────────────────────────────

// Helper: build a minimal hypothesis with a given confidence and completion zone
function mkHyp(confVal, zLo, zHi, bias = 'bull', stage = 'formingC') {
  return {
    stage, bias,
    typeBranch: ['regular'],
    anchor: { preO: pv(200), O: pv(100), A: pv(150), B: pv(106), C: null },
    legA: 50, rB: 0.88,
    zones: {
      completion: { regular: [zLo, zHi] },
      invalidation: { hard_1deg: 200, soft: [zLo - 10, zHi + 10] },
      tp: [6, 106],
    },
    confidence: { value: confVal, components: {} },
  };
}

test('beam: never returns more than k results', () => {
  const hyps = Array.from({ length: 10 }, (_, i) => mkHyp(i * 0.1, 150 + i, 165 + i));
  assert.ok(beam(hyps, 4).length <= 4, 'beam should cap at k=4');
});

test('beam: results are sorted by confidence descending', () => {
  const hyps = [mkHyp(0.3, 150, 165), mkHyp(0.8, 155, 170), mkHyp(0.5, 152, 167)];
  const b = beam(hyps, 4);
  for (let i = 1; i < b.length; i++) {
    assert.ok(b[i - 1].confidence.value >= b[i].confidence.value,
      'beam output must be sorted descending');
  }
});

test('beam: returns fewer than k when input is smaller', () => {
  const hyps = [mkHyp(0.6, 150, 165)];
  assert.equal(beam(hyps, 4).length, 1, 'should return all when < k');
});

test('mergeOverlapping: fully-overlapping zones collapse to 1 scenario', () => {
  // Two hyps with identical zones — same scenario
  const h1 = mkHyp(0.7, 150, 165);
  const h2 = mkHyp(0.5, 150, 165);
  const merged = mergeOverlapping([h1, h2]);
  assert.equal(merged.length, 1, 'identical zones should merge');
});

test('mergeOverlapping: heavily-overlapping zones collapse to 1 scenario', () => {
  // [152, 163] overlaps [150, 165] with Jaccard = 11/15 ≈ 0.73 > 0.50 threshold
  const h1 = mkHyp(0.7, 150, 165);
  const h2 = mkHyp(0.5, 152, 163);
  const merged = mergeOverlapping([h1, h2]);
  assert.equal(merged.length, 1, 'heavily overlapping zones should merge');
});

test('mergeOverlapping: non-overlapping zones stay separate', () => {
  // [150, 155] vs [170, 180] — no overlap
  const h1 = mkHyp(0.7, 150, 155);
  const h2 = mkHyp(0.5, 170, 180);
  const merged = mergeOverlapping([h1, h2]);
  assert.equal(merged.length, 2, 'non-overlapping zones must remain distinct');
});

test('mergeOverlapping: different bias never merges even with identical zones', () => {
  const h1 = mkHyp(0.7, 150, 165, 'bull');
  const h2 = mkHyp(0.5, 150, 165, 'bear');
  const merged = mergeOverlapping([h1, h2]);
  assert.equal(merged.length, 2, 'bull and bear scenarios must never merge');
});

test('mergeOverlapping: primary keeps highest confidence after merge', () => {
  const h1 = mkHyp(0.5, 150, 165);  // lower confidence
  const h2 = mkHyp(0.8, 152, 164);  // higher confidence — should be primary
  const merged = mergeOverlapping([h1, h2]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].confidence.value, 0.8, 'merged scenario should have highest confidence');
});

test('mergeOverlapping: unions type branches from both hypotheses', () => {
  const h1 = { ...mkHyp(0.7, 150, 165), typeBranch: ['regular'] };
  const h2 = { ...mkHyp(0.5, 152, 163), typeBranch: ['contracting'] };
  const merged = mergeOverlapping([h1, h2]);
  assert.equal(merged.length, 1);
  assert.ok(merged[0].typeBranch.includes('regular'),     'should include regular');
  assert.ok(merged[0].typeBranch.includes('contracting'), 'should include contracting');
});

test('rankAndBeam: > 4 input hypotheses → exactly ≤ 4 output', () => {
  const hyps = Array.from({ length: 8 }, (_, i) => mkHyp(i * 0.1, 140 + i * 5, 155 + i * 5));
  const result = rankAndBeam(hyps, 4);
  assert.ok(result.length <= 4, 'rankAndBeam must cap at k=4');
});

test('rankAndBeam: output contains the highest-confidence scenarios', () => {
  const low  = mkHyp(0.20, 150, 155);
  const high = mkHyp(0.90, 200, 210);  // non-overlapping, distinct scenario
  const mid  = mkHyp(0.50, 170, 180);
  const result = rankAndBeam([low, high, mid], 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].confidence.value, 0.90, 'highest confidence should be first');
  assert.equal(result[1].confidence.value, 0.50, 'second should be mid confidence');
});

test('rankAndBeam: confidence monotone across stages for same O/A geometry', () => {
  // Same O/A, with B adding formingC and C adding awaiting2°
  const pivots5 = [pv(200,'H'), pv(100,'L'), pv(150,'H'), pv(106,'L'), pv(158,'H')];
  const hyps    = enumerateHypotheses(pivots5, 155);
  const ranked  = rankAndBeam(hyps, 4);
  // The most advanced stage (awaiting2°) should rank above formingC, above formingB
  // Keep the highest-confidence entry per stage (beam is sorted, so first wins)
  const byStage = {};
  for (const h of ranked) {
    if (byStage[h.stage] == null) byStage[h.stage] = h.confidence.value;
  }
  if (byStage.formingB   != null && byStage.formingC      != null) assert.ok(byStage.formingC      > byStage.formingB);
  if (byStage.formingC   != null && byStage['awaiting2°'] != null) assert.ok(byStage['awaiting2°'] > byStage.formingC);
});
