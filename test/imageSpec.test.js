// Tests — ⑥ image grammar spec builders (pure geometry).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patternImageSpec, hypImageSpec } from '../src/core/imageSpec.js';

const P = (time, price) => ({ time, price });

// ── patternImageSpec (historical) ─────────────────────────────────────────────

const pivots = [P(1, 200), P(2, 100), P(3, 150), P(4, 110), P(5, 155), P(6, 90)];
const pattern = {
  aStart: P(2, 100), aEnd: P(3, 150), bEnd: P(4, 110), cEnd: P(5, 155),
  bias: 'bull', type: 'regular',
};

test('patternImageSpec: 1°→O + O→B + A→C + C→2°, all solid', () => {
  const spec = patternImageSpec(pattern, pivots);
  const impulses = spec.segments.filter(s => s.role === 'impulse');
  const rails    = spec.segments.filter(s => s.role === 'rail');
  assert.equal(impulses.length, 2, '1°→O and C→2°');
  assert.equal(rails.length, 2, 'O→B and A→C');
  assert.ok(spec.segments.every(s => s.dashed === false), 'historical: nothing projected');
  assert.equal(impulses[0].from.price, 200, '1° is the pivot before O');
  assert.equal(impulses[1].to.price, 90, '2° is the pivot after C');
  assert.deepEqual(spec.points.map(p => p.label), ['1°', 'O', 'A', 'B', 'C', '2°']);
});

test('patternImageSpec: missing 1°/2° neighbours are skipped (edge of data)', () => {
  const spec = patternImageSpec(pattern, [pattern.aStart, pattern.aEnd, pattern.bEnd, pattern.cEnd]);
  assert.equal(spec.segments.filter(s => s.role === 'impulse').length, 0, 'no neighbours → no impulses');
  assert.equal(spec.segments.filter(s => s.role === 'rail').length, 2, 'rails still present');
});

// ── hypImageSpec (predictive) ─────────────────────────────────────────────────

const baseAnchor = { preO: P(1, 200), O: P(2, 100), A: P(3, 150), B: P(4, 106) };

test('hypImageSpec awaiting2°: A→C solid, C→2° dashed to TP, TP zone', () => {
  const hyp = {
    bias: 'bull', stage: 'awaiting2°', typeBranch: ['regular', 'contracting'],
    anchor: { ...baseAnchor, C: P(5, 158) },
    zones: { tp: [6, 106] },
  };
  const spec = hypImageSpec(hyp);
  const acRail = spec.segments.find(s => s.role === 'rail' && s.from.price === 150);
  assert.ok(acRail && acRail.dashed === false, 'A→C confirmed (solid)');
  const exit = spec.segments.find(s => s.role === 'impulse' && s.from.price === 158);
  assert.ok(exit && exit.dashed === true, 'C→2° projected (dashed)');
  assert.equal(exit.to.price, 6, 'bull flat → bearish TP target tp[0]');
  assert.equal(spec.zones.length, 1, 'TP zone present');
});

test('hypImageSpec formingC fork: two dashed A→C rails (one per branch) + two C→2°', () => {
  const hyp = {
    bias: 'bull', stage: 'formingC', rB: 0.88, typeBranch: ['regular', 'contracting'],
    anchor: { ...baseAnchor, C: null },
    zones: { completion: { regular: [150, 165], contracting: [140, 150] }, tp: [6, 106] },
  };
  const spec = hypImageSpec(hyp);
  const dashedRails = spec.segments.filter(s => s.role === 'rail' && s.dashed);
  assert.equal(dashedRails.length, 2, 'one projected A→C rail per branch');
  const dashedImpulses = spec.segments.filter(s => s.role === 'impulse' && s.dashed);
  assert.equal(dashedImpulses.length, 2, 'one projected C→2° per branch');
  assert.equal(spec.type, null, 'fork has no single type');
  const wsum = dashedRails.reduce((s, r) => s + r.weight, 0);
  assert.ok(Math.abs(wsum - 1) < 1e-9, `branch weights normalised, got ${wsum}`);
  // confirmed parts still solid
  assert.ok(spec.segments.some(s => s.role === 'rail' && !s.dashed), 'O→B confirmed rail');
  assert.ok(spec.segments.some(s => s.role === 'impulse' && !s.dashed), '1°→O confirmed impulse');
});

test('hypImageSpec formingB → null (④b gate, no determined type)', () => {
  const hyp = {
    bias: 'bull', stage: 'formingB', typeBranch: null,
    anchor: { preO: P(1, 200), O: P(2, 100), A: P(3, 150), B: null },
    zones: { invalidation: { soft: [80, 200] } },
  };
  assert.equal(hypImageSpec(hyp), null);
});
