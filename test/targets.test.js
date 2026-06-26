import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confluence, enrichScenario, enrichScenarios } from '../src/core/targets.js';

test('confluence clusters nearby levels and ranks by weight', () => {
  const c = confluence(
    [{ price: 100 }, { price: 101 }, { price: 150 }, { price: 151 }, { price: 152 }],
    0.02,
  );
  assert.equal(c.length, 2);
  assert.equal(c[0].price, 151);     // densest cluster (3 members) first
  assert.equal(c[0].weight, 3);
  assert.equal(c[1].price, 100.5);
  assert.equal(c[1].weight, 2);
});

test('enrichScenario picks confluent TP and computes R:R (up bias)', () => {
  const s = {
    bias: 'up', invalidation: 90,
    targets: [{ label: '1.0x', ratio: 1.0, price: 120 }, { label: '1.618x', ratio: 1.618, price: 150 }],
  };
  const e = enrichScenario(s, { price: 100, structuralLevels: [{ price: 121, source: 'pivot' }] });
  // 120 (fib) + 121 (structure) cluster -> primary TP near 120.5
  assert.ok(e.tp.price > 120 && e.tp.price < 121, `tp=${e.tp.price}`);
  assert.equal(e.switchPrice, e.tp.price);
  assert.ok(e.rr > 2 && e.rr < 2.2, `rr=${e.rr}`); // reward ~20.5 / risk 10
});

test('enrichScenario respects direction for a down-bias scenario', () => {
  const s = { bias: 'down', invalidation: 110, targets: [{ label: '0.5', ratio: 0.5, price: 80 }] };
  const e = enrichScenario(s, { price: 100, structuralLevels: [{ price: 79 }, { price: 130 }] });
  // only sub-100 levels are valid targets for a down move; 130 is ignored
  assert.ok(e.tp.price < 100);
  assert.ok(e.tp.members.every((m) => m.price < 100));
});

test('enrichScenarios maps across a list', () => {
  const ranked = [
    { bias: 'up', invalidation: 90, targets: [{ label: '1x', ratio: 1, price: 120 }] },
    { bias: 'down', invalidation: 110, targets: [{ label: '0.5', ratio: 0.5, price: 80 }] },
  ];
  const out = enrichScenarios(ranked, { price: 100, structuralLevels: [] });
  assert.equal(out.length, 2);
  assert.ok(out.every((s) => Number.isFinite(s.rr)));
});
