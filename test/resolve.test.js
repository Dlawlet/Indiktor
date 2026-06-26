// Tests for zone-aware auto-resolution using tpLo/tpHi snapshot fields.
// These tests exercise the new code path where the resolver reads pre-computed
// tpLo/tpHi from the snapshot rather than deriving them from scenario.targets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScenario } from '../src/feedback/resolve.js';

const candle = (time, high, low) => ({ time, high, low });

// Scenario snapshots that carry tpLo/tpHi (new format).
const upZoneScenario = {
  id: 'up-zone', name: 'Wave 3 up', bias: 'up', pattern: 'impulse',
  invalidation: 90,
  tpLo: 120, // near edge of zone for up bias
  tpHi: 140, // far edge
  targetCount: 2,
  isPrimary: true,
  targets: [], // deliberately empty to confirm tpLo/tpHi are used, not targets
};

const downZoneScenario = {
  id: 'down-zone', name: 'Wave C down', bias: 'down', pattern: 'correction',
  invalidation: 110,
  tpLo: 60,  // far edge for down bias
  tpHi: 80,  // near edge of zone for down bias
  targetCount: 2,
  isPrimary: false,
  targets: [],
};

// 1. UP scenario: price high reaches tpLo (near edge) before invalidation → target-hit
test('resolveScenario zone-aware: UP scenario target-hit when high reaches tpLo', () => {
  const candles = [
    candle(2, 115, 100), // below tpLo=120, above invalidation=90 → pending
    candle(3, 122, 118), // high 122 >= tpLo 120 → target-hit
  ];
  const r = resolveScenario(upZoneScenario, candles);
  assert.equal(r.outcome, 'target-hit');
  assert.equal(r.resolver, 'auto');
  assert.equal(r.price, 120); // near edge reported
  assert.equal(r.time, 3);
});

// 2. DOWN scenario: price low reaches tpHi (near edge for down) before invalidation → target-hit
test('resolveScenario zone-aware: DOWN scenario target-hit when low reaches tpHi', () => {
  const candles = [
    candle(2, 105, 95),  // above tpHi=80, below invalidation=110 → pending
    candle(3, 85, 78),   // low 78 <= tpHi 80 → target-hit
  ];
  const r = resolveScenario(downZoneScenario, candles);
  assert.equal(r.outcome, 'target-hit');
  assert.equal(r.resolver, 'auto');
  assert.equal(r.price, 80); // near edge (tpHi) for down bias
  assert.equal(r.time, 3);
});

// 3. Invalidation fires before target zone is entered → invalidated
test('resolveScenario zone-aware: invalidation fires before target zone → invalidated', () => {
  const candles = [
    candle(2, 108, 95),  // no level hit
    candle(3, 109, 88),  // low 88 <= invalidation 90 → invalidated
    candle(4, 125, 118), // would have hit tpLo — but too late
  ];
  const r = resolveScenario(upZoneScenario, candles);
  assert.equal(r.outcome, 'invalidated');
  assert.equal(r.price, 90);
  assert.equal(r.time, 3);
});
