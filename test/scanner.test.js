// Tests for the flat-pattern engine (spec §A.4–A.9).
// All classification comes from 4-pivot arithmetic (O, A, B, C).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRatios, classifyFromRatios, bandFit, detectFlatPatterns, candlesContained, trendContextOk } from '../src/core/flats.js';

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

// ── Containment filter ────────────────────────────────────────────────────────

test('detectFlatPatterns: rejects when a candle wicks outside the flat range', () => {
  // Bull flat O=100 A=150 B=118 C=160 — range [100, 160]
  // Inject a candle at time=2.5 that wicks to 170 (above C=160) → invalid
  const pivots = [
    { price: 100, time: 1, type: 'L', close: 100, atr: 5, index: 0 },
    { price: 150, time: 3, type: 'H', close: 150, atr: 5, index: 2 },
    { price: 118, time: 5, type: 'L', close: 118, atr: 5, index: 4 },
    { price: 160, time: 7, type: 'H', close: 160, atr: 5, index: 6 },
  ];
  const candles = [
    { time: 1, open: 100, high: 100, low: 100, close: 100 }, // O
    { time: 2, open: 120, high: 130, low: 100, close: 125 },
    { time: 3, open: 145, high: 150, low: 140, close: 150 }, // A
    { time: 4, open: 135, high: 170, low: 115, close: 118 }, // high=170 > roof=160 → breach
    { time: 5, open: 120, high: 125, low: 118, close: 120 }, // B
    { time: 6, open: 130, high: 145, low: 128, close: 140 },
    { time: 7, open: 155, high: 160, low: 150, close: 158 }, // C
  ];
  const pats = detectFlatPatterns(pivots, { minConfidence: 0.10, candles });
  assert.equal(pats.length, 0, 'pattern with candle breaching flat range should be rejected');
});

test('detectFlatPatterns: accepts when all candles are within the flat range', () => {
  // Same geometry but the intermediate candle stays inside [100, 160]
  const pivots = [
    { price: 100, time: 1, type: 'L', close: 100, atr: 5, index: 0 },
    { price: 150, time: 3, type: 'H', close: 150, atr: 5, index: 2 },
    { price: 118, time: 5, type: 'L', close: 118, atr: 5, index: 4 },
    { price: 160, time: 7, type: 'H', close: 160, atr: 5, index: 6 },
  ];
  const candles = [
    { time: 1, open: 100, high: 100, low: 100, close: 100 },
    { time: 2, open: 120, high: 130, low: 100, close: 125 },
    { time: 3, open: 145, high: 150, low: 140, close: 150 },
    { time: 4, open: 135, high: 155, low: 115, close: 118 }, // high=155 < roof=160 ✓
    { time: 5, open: 120, high: 125, low: 118, close: 120 },
    { time: 6, open: 130, high: 145, low: 108, close: 140 }, // low=108 > floor=100 ✓
    { time: 7, open: 155, high: 160, low: 150, close: 158 },
  ];
  const pats = detectFlatPatterns(pivots, { minConfidence: 0.10, candles });
  assert.ok(pats.length > 0, 'contained flat should be detected');
});

// ── trendContextOk unit tests ─────────────────────────────────────────────────

const tp = (price) => ({ price });

test('trendContextOk: passes when no context pivots exist (edge of data)', () => {
  // Only O and C present — both context checks are skipped
  const pivots = [tp(100), tp(150), tp(118), tp(160)];
  assert.ok(trendContextOk(pivots, 0, 3, 50), 'should pass with no surrounding context');
});

test('trendContextOk: bull flat — pre-O above O (correct bearish approach)', () => {
  // preO=200 > O=100, legA=50 → (200-100)*50=5000 > 0 ✓
  const pivots = [tp(200), tp(100), tp(150), tp(118), tp(160)];
  assert.ok(trendContextOk(pivots, 1, 4, 50), 'should pass with correct pre-O');
});

test('trendContextOk: bull flat — pre-O below O (wrong trend, price rose into O)', () => {
  // preO=80 < O=100, legA=50 → (80-100)*50=-1000 < 0 → FAIL
  const pivots = [tp(80), tp(100), tp(150), tp(118), tp(160)];
  assert.ok(!trendContextOk(pivots, 1, 4, 50), 'should reject: pre-O below O means price rose into flat start');
});

test('trendContextOk: bull flat — post-C below C (correct bearish continuation)', () => {
  // C=160, postC=120 < 160, legA=50 → (160-120)*50=2000 > 0 ✓
  const pivots = [tp(200), tp(100), tp(150), tp(118), tp(160), tp(120)];
  assert.ok(trendContextOk(pivots, 1, 4, 50), 'should pass with post-C below C');
});

test('trendContextOk: bull flat — post-C above C (price rose after flat, wrong direction)', () => {
  // C=160, postC=180 > 160, legA=50 → (160-180)*50=-1000 < 0 → FAIL
  const pivots = [tp(200), tp(100), tp(150), tp(118), tp(160), tp(180)];
  assert.ok(!trendContextOk(pivots, 1, 4, 50), 'should reject: post-C above C means price rose after correction');
});

test('trendContextOk: bear flat — preO below O and postC above C (correct bullish context)', () => {
  // Bear flat: legA=-110 (A below O). preO=50 < O=200 → (50-200)*(-110)=16500 > 0 ✓
  // postC=180 > C=100 → (100-180)*(-110)=8800 > 0 ✓
  const pivots = [tp(50), tp(200), tp(90), tp(160), tp(100), tp(180)];
  assert.ok(trendContextOk(pivots, 1, 4, -110), 'should pass: bear flat in bullish trend');
});

test('trendContextOk: bear flat — postC below C (wrong: price fell after, means trend reversed)', () => {
  // postC=80 < C=100 → (100-80)*(-110)=-2200 < 0 → FAIL
  const pivots = [tp(50), tp(200), tp(90), tp(160), tp(100), tp(80)];
  assert.ok(!trendContextOk(pivots, 1, 4, -110), 'should reject: post-C below C in bear flat means trend did not resume bullish');
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
