import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankScenarios, directionalLean } from '../src/core/scoring.js';

const fakeAnalysis = {
  live: { price: 200 },
  scenarios: [
    { id: 'a', bias: 'up', prior: 0.6, guideline: 0.9, invalidation: 150, rules: { failed: [] } },
    { id: 'b', bias: 'down', prior: 0.4, guideline: 0.3, invalidation: 260, rules: { failed: [] } },
    { id: 'c', bias: 'up', prior: 0.5, guideline: 0.0, invalidation: 100, rules: { failed: ['r3'] } },
  ],
};

test('rankScenarios produces probabilities summing to 1, sorted desc', () => {
  const ranked = rankScenarios(fakeAnalysis);
  const sum = ranked.reduce((a, b) => a + b.probability, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].probability >= ranked[i].probability);
  }
  assert.equal(ranked[0].id, 'a'); // highest prior x guideline
});

test('a hard-rule failure removes the scenario from ranking entirely', () => {
  const ranked = rankScenarios(fakeAnalysis);
  const c = ranked.find((s) => s.id === 'c');
  assert.equal(c, undefined, 'rule-failed scenario is filtered out, not just collapsed');
});

test('invalidation distance is computed relative to live price', () => {
  const ranked = rankScenarios(fakeAnalysis);
  const a = ranked.find((s) => s.id === 'a');
  assert.ok(Math.abs(a.invalidationPct - (150 - 200) / 200) < 1e-9);
});

test('directionalLean aggregates probability mass by side', () => {
  const ranked = rankScenarios(fakeAnalysis);
  const lean = directionalLean(ranked);
  assert.ok(Math.abs(lean.up + lean.down - 1) < 1e-9);
  assert.ok(['bullish', 'bearish', 'mixed'].includes(lean.label));
});
