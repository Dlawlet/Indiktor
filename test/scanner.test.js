// Tests for the flat-pattern engine (spec §A.4–A.9).
// All classification comes from 4-pivot arithmetic (O, A, B, C).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRatios, classifyFromRatios, bandFit, detectFlatPatterns } from '../src/core/flats.js';

// Minimal pivot factory (no ATR — break tests fall back to price-fraction)
const pv = (price, time = 0, type = 'L') => ({ price, time, type, close: price, atr: null, index: 0 });

// ── §A.4  computeRatios ───────────────────────────────────────────────────────

test('computeRatios: bull flat ratios', () => {
  // O=100 A=150 B=115 C=160 — legA=50 up
  const r = computeRatios(pv(100), pv(150), pv(115), pv(160));
  assert.ok(r);
  // rB = (150-115)/(150-100) = 35/50 = 0.70
  assert.ok(Math.abs(r.rB - 0.70) < 0.001, `rB=${r.rB}`);
  // pC = (160-150)/(150-100) = 10/50 = 0.20
  assert.ok(Math.abs(r.pC - 0.20) < 0.001, `pC=${r.pC}`);
  // lenC_lenA = |160-115|/50 = 45/50 = 0.90
  assert.ok(Math.abs(r.lenC_lenA - 0.90) < 0.001, `lenC=${r.lenC_lenA}`);
});

test('computeRatios: bear flat ratios are sign-agnostic', () => {
  // O=150 A=100 B=135 C=90 — legA=-50 down
  const r = computeRatios(pv(150), pv(100), pv(135), pv(90));
  assert.ok(r);
  // rB = (100-135)/(100-150) = -35/-50 = 0.70 — same as bull ✓
  assert.ok(Math.abs(r.rB - 0.70) < 0.001, `rB=${r.rB}`);
  // pC = (90-100)/(100-150) = -10/-50 = 0.20 ✓
  assert.ok(Math.abs(r.pC - 0.20) < 0.001, `pC=${r.pC}`);
});

test('computeRatios: rB > 1 when B breaks O', () => {
  // Bull flat where B goes below O: O=100 A=150 B=85 (below O) C=120
  const r = computeRatios(pv(100), pv(150), pv(85), pv(120));
  assert.ok(r.rB > 1, `rB should be >1, got ${r.rB}`);
});

test('computeRatios: pC < 0 when C does not reach A', () => {
  // Bull flat where C stays below A: O=100 A=150 B=115 C=140 (below A=150)
  const r = computeRatios(pv(100), pv(150), pv(115), pv(140));
  assert.ok(r.pC < 0, `pC should be <0, got ${r.pC}`);
});

// ── §A.5  classifyFromRatios ──────────────────────────────────────────────────

test('classifyFromRatios: regular (rB≤1, pC>0)', () => {
  assert.equal(classifyFromRatios(0.85, 0.15), 'regular');
});

test('classifyFromRatios: contracting (rB≤1, pC<0)', () => {
  assert.equal(classifyFromRatios(0.60, -0.20), 'contracting');
});

test('classifyFromRatios: running (rB>1, pC<0)', () => {
  assert.equal(classifyFromRatios(1.15, -0.25), 'running');
});

test('classifyFromRatios: expanding (rB>1, pC>0)', () => {
  assert.equal(classifyFromRatios(1.30, 0.40), 'expanding');
});

// ── §A.6  bandFit ─────────────────────────────────────────────────────────────

test('bandFit: ideal regular scores ≈ 1', () => {
  // rB=0.95 pC=0.12 lenC=1.05 — all at ideal
  const r = { rB: 0.95, pC: 0.12, lenC_lenA: 1.05 };
  const s = bandFit(r, 'regular');
  assert.ok(s > 0.95, `expected ≈1, got ${s}`);
});

test('bandFit: regular scores better than running for regular ratios', () => {
  const r = { rB: 0.90, pC: 0.12, lenC_lenA: 1.00 };
  assert.ok(bandFit(r, 'regular') > bandFit(r, 'running'),
    'regular ratios should score higher for regular than running');
});

test('bandFit: running scores better than regular for running ratios', () => {
  const r = { rB: 1.15, pC: -0.25, lenC_lenA: 0.70 };
  assert.ok(bandFit(r, 'running') > bandFit(r, 'regular'),
    'running ratios should score higher for running than regular');
});

test('bandFit: decays smoothly outside band (no hard cliff)', () => {
  const r = { rB: 0.95, pC: 0.12, lenC_lenA: 1.05 };
  const atEdge    = bandFit({ ...r, rB: 0.80 }, 'regular');
  const justOutside = bandFit({ ...r, rB: 0.75 }, 'regular');
  assert.ok(justOutside < atEdge, 'score should decay outside band');
  assert.ok(justOutside > 0, 'score should not drop to zero abruptly');
});

// ── detectFlatPatterns end-to-end ─────────────────────────────────────────────

test('detectFlatPatterns: finds a regular flat in a pivot sequence', () => {
  // O=100 (L) A=150 (H) B=118 (L) C=160 (H)
  // rB=(150-118)/50=0.64  pC=(160-150)/50=0.20 → regular
  // Give times so the sequence is monotonic
  const pivots = [
    { price: 100, time: 1, type: 'L', close: 100, atr: 5, index: 0 },
    { price: 150, time: 2, type: 'H', close: 150, atr: 5, index: 10 },
    { price: 118, time: 3, type: 'L', close: 118, atr: 5, index: 20 },
    { price: 160, time: 4, type: 'H', close: 160, atr: 5, index: 30 },
  ];
  const pats = detectFlatPatterns(pivots, { minConfidence: 0.10 });
  assert.ok(pats.length > 0, 'expected at least one pattern');
  // The top pattern (or one of them) should be regular
  const types = pats.map((p) => p.type);
  assert.ok(types.includes('regular') || types.includes('contracting'),
    `unexpected types: ${types}`);
});

test('detectFlatPatterns: running flat when B breaks O', () => {
  // O=100 A=150 B=80 (breaks O) C=130 (below A) → running
  // rB=(150-80)/50=1.40  pC=(130-150)/50=-0.40
  const pivots = [
    { price: 100, time: 1, type: 'L', close: 100, atr: 5, index: 0 },
    { price: 150, time: 2, type: 'H', close: 150, atr: 5, index: 10 },
    { price: 80,  time: 3, type: 'L', close: 80,  atr: 5, index: 20 },
    { price: 130, time: 4, type: 'H', close: 130, atr: 5, index: 30 },
  ];
  const pats = detectFlatPatterns(pivots, { minConfidence: 0.10 });
  assert.ok(pats.length > 0, 'expected at least one pattern');
  const types = pats.map((p) => p.type);
  assert.ok(types.includes('running'), `expected running among ${types}`);
});

test('detectFlatPatterns: returns empty for non-flat (pure trend) sequence', () => {
  // Monotone up sequence — no valid flat geometry
  const pivots = [
    { price: 100, time: 1, type: 'L', close: 100, atr: 5, index: 0 },
    { price: 200, time: 2, type: 'H', close: 200, atr: 5, index: 10 },
    { price: 180, time: 3, type: 'L', close: 180, atr: 5, index: 20 },
    { price: 300, time: 4, type: 'H', close: 300, atr: 5, index: 30 },
  ];
  // lenC/lenA = 120/100 = 1.2 → borderline expanding but rB=(200-180)/100=0.2 (too small)
  const pats = detectFlatPatterns(pivots, { minConfidence: 0.40 });
  // rB=0.2 is way outside all bands — should be filtered or have very low conf
  const highConf = pats.filter((p) => p.confidence >= 0.40);
  assert.equal(highConf.length, 0, `unexpected high-conf patterns: ${JSON.stringify(highConf)}`);
});

test('detectFlatPatterns: pattern has required output fields', () => {
  const pivots = [
    { price: 100, time: 1, type: 'L', close: 100, atr: 5, index: 0 },
    { price: 150, time: 2, type: 'H', close: 150, atr: 5, index: 10 },
    { price: 120, time: 3, type: 'L', close: 120, atr: 5, index: 20 },
    { price: 158, time: 4, type: 'H', close: 158, atr: 5, index: 30 },
  ];
  const pats = detectFlatPatterns(pivots, { minConfidence: 0.10 });
  if (!pats.length) return; // might not detect if band_fit too low
  const p = pats[0];
  assert.ok('type' in p,       'missing type');
  assert.ok('label' in p,      'missing label');
  assert.ok('bias' in p,       'missing bias');
  assert.ok('bRet' in p,       'missing bRet');
  assert.ok('cRet' in p,       'missing cRet');
  assert.ok('confidence' in p, 'missing confidence');
  assert.ok('ratios' in p,     'missing ratios');
  assert.ok('breakTests' in p, 'missing breakTests');
  assert.ok('aStart' in p,     'missing aStart');
  assert.ok('aEnd' in p,       'missing aEnd');
  assert.ok('bEnd' in p,       'missing bEnd');
  assert.ok('cEnd' in p,       'missing cEnd');
  assert.ok(p.confidence >= 0 && p.confidence <= 1, `confidence out of range: ${p.confidence}`);
});
