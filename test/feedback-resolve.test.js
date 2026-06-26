import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSnapshot, resolveScenario } from '../src/feedback/resolve.js';

// Minimal candle/snapshot helpers — only fields the resolver reads.
const candle = (time, high, low) => ({ time, high, low });
const snap = (ts, scenarios) => ({ id: 's1', ts, scenarios });

const upScenario = {
  id: 'up', name: 'up', bias: 'up', pattern: 'impulse',
  invalidation: 90, targets: [{ label: '1x', ratio: 1, price: 120 }, { label: '1.6x', ratio: 1.6, price: 140 }],
};
const downScenario = {
  id: 'down', name: 'down', bias: 'down', pattern: 'correction',
  invalidation: 110, targets: [{ label: '1x', ratio: 1, price: 80 }, { label: '1.6x', ratio: 1.6, price: 60 }],
};

test('resolveScenario: up bias target-hit when price reaches the near target edge', () => {
  // near edge of up zone is 120; price climbs to 121 -> hit
  const candles = [candle(2, 110, 100), candle(3, 121, 115)];
  const r = resolveScenario(upScenario, candles);
  assert.equal(r.outcome, 'target-hit');
  assert.equal(r.resolver, 'auto');
  assert.equal(r.price, 120);
  assert.equal(r.time, 3);
});

test('resolveScenario: up bias invalidated when price drops to invalidation first', () => {
  const candles = [candle(2, 110, 100), candle(3, 108, 89)]; // low 89 <= 90 inval
  const r = resolveScenario(upScenario, candles);
  assert.equal(r.outcome, 'invalidated');
  assert.equal(r.price, 90);
  assert.equal(r.time, 3);
});

test('resolveScenario: down bias target-hit when price falls to the near target edge', () => {
  // near edge of down zone is the HIGH price 80; low 79 reaches it
  const candles = [candle(2, 100, 95), candle(3, 85, 79)];
  const r = resolveScenario(downScenario, candles);
  assert.equal(r.outcome, 'target-hit');
  assert.equal(r.price, 80);
  assert.equal(r.time, 3);
});

test('resolveScenario: down bias invalidated when price rises to invalidation first', () => {
  const candles = [candle(2, 105, 95), candle(3, 111, 102)]; // high 111 >= 110 inval
  const r = resolveScenario(downScenario, candles);
  assert.equal(r.outcome, 'invalidated');
  assert.equal(r.price, 110);
});

test('resolveScenario: pending when neither level reached', () => {
  const candles = [candle(2, 115, 95), candle(3, 118, 100)]; // never <90, never >=120
  const r = resolveScenario(upScenario, candles);
  assert.equal(r.outcome, 'pending');
  assert.equal(r.price, null);
  assert.equal(r.time, null);
});

test('resolveScenario: chronology decides — invalidation first then target later', () => {
  // candle 3 hits invalidation (low 88); candle 4 would hit target — but inval is first
  const candles = [candle(3, 100, 88), candle(4, 125, 119)];
  const r = resolveScenario(upScenario, candles);
  assert.equal(r.outcome, 'invalidated');
  assert.equal(r.time, 3);
});

test('resolveScenario: single straddling candle resolves to invalidated (conservative)', () => {
  // one wide bar: high 125 (>=120 target) AND low 85 (<=90 inval)
  const candles = [candle(5, 125, 85)];
  const r = resolveScenario(upScenario, candles);
  assert.equal(r.outcome, 'invalidated');
  assert.match(r.reason, /straddled/);
});

test('resolveSnapshot: ignores candles at/before snapshot ts and resolves all scenarios', () => {
  const s = snap(10, [upScenario, downScenario]);
  const candles = [
    candle(5, 200, 50),   // before ts -> ignored even though it straddles everything
    candle(11, 121, 115), // up target hit
    candle(12, 111, 100), // down invalidated
  ];
  const out = resolveSnapshot(s, candles);
  assert.equal(out.snapshotId, 's1');
  assert.equal(out.resolvedThrough, 12);
  const up = out.resolutions.find((r) => r.scenarioId === 'up');
  const down = out.resolutions.find((r) => r.scenarioId === 'down');
  assert.equal(up.outcome, 'target-hit');
  assert.equal(down.outcome, 'invalidated');
});
