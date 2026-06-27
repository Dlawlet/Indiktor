// Tests — Phase 6c: fractal.js
// Validates inter-TF constraint propagation (P.5), scaleStability, nestingCoherence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRelation, applyFractalConstraints,
  scaleStability, nestingCoherence, withFractal,
} from '../src/core/fractal.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Bull flat hypothesis: legA=50, correction UP, continuation DOWN (bearish trend).
//   O=100(L), A=150(H), B=106(L), preO=200(H) → hard_1deg=200 (a high).
//   TP goes DOWN: [6, 106].
function mkBullHyp(tpLo = 6, tpHi = 106, confVal = 0.60) {
  return {
    bias: 'bull', stage: 'formingC', legA: 50,
    anchor: {
      O: { price: 100, type: 'L', time: 1, index: 1 },
      A: { price: 150, type: 'H', time: 2, index: 2 },
      B: { price: 106, type: 'L', time: 3, index: 3 },
      C: null,
    },
    zones: {
      tp: [tpLo, tpHi],
      invalidation: { hard_1deg: 200, soft: [140, 210] },
      completion: { regular: [150, 165] },
    },
    confidence: { value: confVal, components: { fractal_consistency: 1.0 } },
  };
}

// Bear flat hypothesis: legA=-110, correction DOWN, continuation UP (bullish trend).
//   O=200(H), A=90(L), B=160(H), preO=50(L) → hard_1deg=50 (a low).
//   TP goes UP: [160, 220].
function mkBearHyp(tpLo = 160, tpHi = 220, confVal = 0.60) {
  return {
    bias: 'bear', stage: 'formingC', legA: -110,
    anchor: {
      O: { price: 200, type: 'H', time: 10, index: 10 },
      A: { price:  90, type: 'L', time: 11, index: 11 },
      B: { price: 160, type: 'H', time: 12, index: 12 },
      C: null,
    },
    zones: {
      tp: [tpLo, tpHi],
      invalidation: { hard_1deg: 50, soft: [40, 170] },
      completion: { regular: [90, 80] },
    },
    confidence: { value: confVal, components: { fractal_consistency: 1.0 } },
  };
}

// Higher-TF goal: bull flat g with hard_1deg=200 (a high; invalidated if price > 200)
function mkBullGoal(hard1deg = 200) {
  return {
    bias: 'bull',
    zones: { tp: [6, 106], invalidation: { hard_1deg: hard1deg } },
  };
}
// Higher-TF goal: bear flat g with hard_1deg=50 (a low; invalidated if price < 50)
function mkBearGoal(hard1deg = 50) {
  return {
    bias: 'bear',
    zones: { tp: [160, 220], invalidation: { hard_1deg: hard1deg } },
  };
}

// ── classifyRelation ──────────────────────────────────────────────────────────

test('classifyRelation: same bias → concordant', () => {
  // Both bull flats (both corrections in a bearish trend)
  assert.equal(classifyRelation(mkBullHyp(), mkBullGoal()), 'concordant');
});

test('classifyRelation: same bias bear → concordant', () => {
  assert.equal(classifyRelation(mkBearHyp(), mkBearGoal()), 'concordant');
});

test('classifyRelation: no goal → neutral', () => {
  assert.equal(classifyRelation(mkBullHyp(), null), 'neutral');
});

test('classifyRelation: bear h inside bull g, TP below hard_1deg → neutral (no cross)', () => {
  // bear h TP = [160, 220], bull g hard_1deg = 250 → tpHi=220 < 250 → does NOT cross
  const h = mkBearHyp(160, 220);
  const g = mkBullGoal(250);
  assert.equal(classifyRelation(h, g), 'neutral');
});

test('classifyRelation: bear h inside bull g, TP crosses hard_1deg → contradictory', () => {
  // bear h TP = [160, 210], bull g hard_1deg = 200 → tpHi=210 > 200 → crosses → contradictory
  const h = mkBearHyp(160, 210);
  const g = mkBullGoal(200);
  assert.equal(classifyRelation(h, g), 'contradictory');
});

test('classifyRelation: bull h inside bear g, TP above hard_1deg → neutral (no cross)', () => {
  // bull h TP = [60, 106], bear g hard_1deg = 50 → tpLo=60 > 50 → does NOT cross
  const h = mkBullHyp(60, 106);
  const g = mkBearGoal(50);
  assert.equal(classifyRelation(h, g), 'neutral');
});

test('classifyRelation: bull h inside bear g, TP crosses hard_1deg → contradictory', () => {
  // bull h TP = [30, 106], bear g hard_1deg = 50 → tpLo=30 < 50 → crosses → contradictory
  const h = mkBullHyp(30, 106);
  const g = mkBearGoal(50);
  assert.equal(classifyRelation(h, g), 'contradictory');
});

// ── applyFractalConstraints ───────────────────────────────────────────────────

test('applyFractalConstraints: no goal → all kept unchanged', () => {
  const hyps = [mkBullHyp(), mkBullHyp(6, 106, 0.8)];
  const { kept, alternatives } = applyFractalConstraints(hyps, null);
  assert.equal(kept.length, 2);
  assert.equal(alternatives.length, 0);
});

test('applyFractalConstraints: concordant → confidence boosted', () => {
  const h = mkBullHyp(6, 106, 0.50);          // bull h
  const g = mkBullGoal();                       // bull g → concordant
  const { kept } = applyFractalConstraints([h], g, { boostFactor: 1.30 });
  assert.equal(kept.length, 1);
  assert.ok(kept[0].confidence.value > 0.50,
    `confidence should increase from 0.50, got ${kept[0].confidence.value.toFixed(3)}`);
  assert.equal(kept[0].fractalRelation, 'concordant');
});

test('applyFractalConstraints: concordant → fractal_consistency component updated', () => {
  const h = mkBullHyp(6, 106, 0.50);
  const g = mkBullGoal();
  const { kept } = applyFractalConstraints([h], g, { boostFactor: 1.30, maxBoost: 2.0 });
  const fc = kept[0].confidence.components.fractal_consistency;
  assert.ok(fc > 1.0, `fractal_consistency should be > 1.0, got ${fc.toFixed(3)}`);
  assert.ok(fc <= 2.0, 'fractal_consistency should be capped at maxBoost');
});

test('applyFractalConstraints: contradictory → goal_invalidates flagged', () => {
  // bear h TP goes to 210, bull g hard_1deg=200 → contradictory
  const h = mkBearHyp(160, 210, 0.50);
  const g = mkBullGoal(200);
  const { alternatives } = applyFractalConstraints([h], g);
  assert.equal(alternatives.length, 1);
  assert.ok(alternatives[0].goal_invalidates, 'contradictory scenario must be flagged');
});

test('applyFractalConstraints: contradictory above pruneThreshold → still in kept (penalized)', () => {
  const h = mkBearHyp(160, 210, 0.80);
  const g = mkBullGoal(200);
  const { kept } = applyFractalConstraints([h], g, { penaltyFactor: 0.50, pruneThreshold: 0.15 });
  assert.equal(kept.length, 1, 'high-confidence contradictory kept as alternative branch');
  assert.ok(kept[0].confidence.value < 0.80, 'contradictory should be penalized');
});

test('applyFractalConstraints: contradictory below pruneThreshold → dropped from kept', () => {
  const h = mkBearHyp(160, 210, 0.20);
  const g = mkBullGoal(200);
  // After 0.50 penalty: 0.20×0.50 = 0.10 < default pruneThreshold 0.15 → dropped
  const { kept, alternatives } = applyFractalConstraints([h], g,
    { penaltyFactor: 0.50, pruneThreshold: 0.15 });
  assert.equal(kept.length, 0, 'low-confidence contradictory should be dropped from kept');
  assert.equal(alternatives.length, 1, 'still emitted as alternative');
});

test('applyFractalConstraints: impossible (currentPrice crosses h hard_1deg) → dropped', () => {
  // bull h hard_1deg=200; currentPrice=210 > 200 → bull flat invalidated → impossible
  const h = mkBullHyp(6, 106, 0.70);
  const g = mkBullGoal();
  const { kept, alternatives } = applyFractalConstraints([h], g, { currentPrice: 210 });
  assert.equal(kept.length, 0, 'impossible scenario must be dropped');
  assert.equal(alternatives.length, 0, 'impossible scenario must not appear in alternatives');
});

test('applyFractalConstraints: confidence value capped at 1.0', () => {
  const h = mkBullHyp(6, 106, 0.99);
  const g = mkBullGoal();
  const { kept } = applyFractalConstraints([h], g, { boostFactor: 1.50 });
  assert.ok(kept[0].confidence.value <= 1.0, 'confidence must never exceed 1.0');
});

// ── scaleStability ────────────────────────────────────────────────────────────

test('scaleStability: no candles → returns 0.60 (neutral)', () => {
  const hyp = mkBullHyp();
  assert.equal(scaleStability(null, hyp), 0.60);
  assert.equal(scaleStability([], hyp), 0.60);
});

test('scaleStability: hyp with no O.index → returns 0.60 (neutral)', () => {
  const hyp = mkBullHyp();
  hyp.anchor.O = { price: 100, type: 'L', time: 1 };  // no index property
  assert.equal(scaleStability([{}], hyp), 0.60);
});

// ── nestingCoherence ──────────────────────────────────────────────────────────

test('nestingCoherence: no sub-hypotheses → returns 0.60 (neutral)', () => {
  assert.equal(nestingCoherence(mkBullHyp(), null), 0.60);
  assert.equal(nestingCoherence(mkBullHyp(), []), 0.60);
});

test('nestingCoherence: sub-hyps outside known legs → returns 0.55', () => {
  const hyp = mkBullHyp();
  // Sub-hyp whose O.time=99 is BEFORE O.time=1 → outside all legs
  const subH = { ...mkBullHyp(), anchor: { O: { price: 80, time: 99 } } };
  assert.equal(nestingCoherence(hyp, [subH]), 0.55);
});

test('nestingCoherence: all sub-hyps concordant in leg A → returns 1.0', () => {
  const hyp = mkBullHyp();    // O.time=1, A.time=2
  // Sub-hyp in leg A (time between 1 and 2) with same bias 'bull' → correct
  const subH = { bias: 'bull', anchor: { O: { time: 1.5 } } };
  assert.equal(nestingCoherence(hyp, [subH, subH]), 1.0);
});

test('nestingCoherence: all sub-hyps wrong bias in leg A → returns 0.40', () => {
  const hyp = mkBullHyp();    // legABias = 'bull'
  const subH = { bias: 'bear', anchor: { O: { time: 1.5 } } };  // wrong bias
  assert.equal(nestingCoherence(hyp, [subH, subH]), 0.40);
});

test('nestingCoherence: mixed — half correct in leg A → returns 0.70', () => {
  const hyp = mkBullHyp();    // O.time=1, A.time=2, B.time=3
  const good = { bias: 'bull', anchor: { O: { time: 1.5 } } };  // leg A, correct
  const bad  = { bias: 'bear', anchor: { O: { time: 1.5 } } };  // leg A, wrong
  // 1 correct / 2 total → 0.40 + 0.60 * 0.5 = 0.70
  assert.equal(nestingCoherence(hyp, [good, bad]), 0.70);
});

test('nestingCoherence: sub-hyp in leg B with correct (opposite) bias → 1.0', () => {
  const hyp = mkBullHyp();  // O.time=1, A.time=2, B.time=3, legBBias='bear'
  // sub-hyp in leg B (time between 2 and 3) with bias 'bear' → correct for leg B
  const subH = { bias: 'bear', anchor: { O: { time: 2.5 } } };
  assert.equal(nestingCoherence(hyp, [subH]), 1.0);
});

// ── withFractal ───────────────────────────────────────────────────────────────

test('withFractal: no opts → all hyps returned, fractal components set to 0.60', () => {
  const hyps = [mkBullHyp(6, 106, 0.50), mkBullHyp(6, 106, 0.70)];
  const result = withFractal(hyps);
  assert.equal(result.length, 2, 'all hyps returned when no constraints');
  for (const h of result) {
    assert.equal(h.confidence.components.scale_stability,   0.60);
    assert.equal(h.confidence.components.nesting_coherence, 0.60);
  }
});

test('withFractal: concordant goal → confidence boosted above input', () => {
  const hyps = [mkBullHyp(6, 106, 0.50)];
  const goal = mkBullGoal();  // bull h + bull g → concordant
  const result = withFractal(hyps, { goal });
  assert.equal(result.length, 1);
  // confidence.value was 0.50; concordant boost should increase it
  assert.ok(result[0].confidence.value > 0.50,
    `expected boosted confidence > 0.50, got ${result[0].confidence.value.toFixed(3)}`);
});

test('withFractal: impossible hyp dropped when currentPrice given', () => {
  // bull h hard_1deg=200; price=210 → impossible
  const hyps = [mkBullHyp(6, 106, 0.70), mkBullHyp(6, 106, 0.50)];
  const goal = mkBullGoal();
  const result = withFractal(hyps, { goal, currentPrice: 210 });
  assert.equal(result.length, 0, 'all impossible hyps should be dropped');
});
