import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotAnalysis, makeId } from '../src/feedback/snapshot.js';

const ranked = [
  {
    id: 'wave-3', name: 'Wave 3 underway', bias: 'up', pattern: 'impulse',
    prior: 0.65, guideline: 0.55, probability: 0.4, invalidation: 100,
    targets: [
      { label: '2.618x', ratio: 2.618, price: 250 },
      { label: '1.618x', ratio: 1.618, price: 200 },
    ],
  },
  {
    id: 'continuation', name: 'Trend continuation', bias: 'down', pattern: 'continuation',
    prior: 0.3, guideline: 0.3, probability: 0.6, invalidation: 130,
    targets: [{ label: '1x', ratio: 1.0, price: 90 }],
  },
];

test('snapshotAnalysis builds an immutable record with expected fields', () => {
  const rec = snapshotAnalysis(ranked, {
    asset: 'BTCUSDT', timeframe: '1d', priceAtAnalysis: 150, now: () => 1_700_000_000_000,
  });

  assert.equal(rec.asset, 'BTCUSDT');
  assert.equal(rec.timeframe, '1d');
  assert.equal(rec.priceAtAnalysis, 150);
  assert.equal(rec.ts, 1_700_000_000); // ms -> seconds
  assert.equal(typeof rec.id, 'string');
  assert.equal(rec.scenarios.length, 2);

  const s = rec.scenarios[0];
  assert.equal(s.id, 'wave-3');
  assert.equal(s.bias, 'up');
  assert.equal(s.invalidation, 100);
  // feature vector
  assert.equal(s.features.prior, 0.65);
  assert.equal(s.features.guideline, 0.55);
  assert.equal(s.features.pattern, 'impulse');
  assert.equal(s.features.probability, 0.4);
  // target ratios are sorted ascending
  assert.deepEqual(s.features.targetRatios, [1.618, 2.618]);
});

test('snapshotAnalysis record is deeply frozen (immutable)', () => {
  const rec = snapshotAnalysis(ranked, { asset: 'X', timeframe: '1h', priceAtAnalysis: 1 });
  assert.ok(Object.isFrozen(rec));
  assert.ok(Object.isFrozen(rec.scenarios));
  assert.ok(Object.isFrozen(rec.scenarios[0]));
  assert.ok(Object.isFrozen(rec.scenarios[0].features));
  assert.ok(Object.isFrozen(rec.scenarios[0].targets));
  // mutation attempts are silently ignored (frozen), value unchanged
  assert.throws(() => { 'use strict'; rec.asset = 'mutated'; });
  assert.equal(rec.asset, 'X');
});

test('snapshotAnalysis accepts a raw analyze() result ({scenarios})', () => {
  const rec = snapshotAnalysis({ scenarios: ranked }, { asset: 'A', timeframe: '4h', priceAtAnalysis: 10 });
  assert.equal(rec.scenarios.length, 2);
});

test('makeId returns a non-empty string', () => {
  const id = makeId();
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);
});
