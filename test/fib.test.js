import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retracements, extensions, projectFrom, ratioOf, fibCleanliness } from '../src/core/fib.js';

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('retracements: 0.382 and 0.618 of a 100->200 move', () => {
  const r = retracements(100, 200, [0.382, 0.618]);
  assert.ok(approx(r[0].price, 161.8));
  assert.ok(approx(r[1].price, 138.2));
});

test('extensions: 1.618 of 100->200 from start', () => {
  const e = extensions(100, 200, [1.0, 1.618]);
  assert.ok(approx(e[0].price, 200));
  assert.ok(approx(e[1].price, 261.8));
});

test('projectFrom: wave-3 = 1.618x wave-1 from wave-2 end', () => {
  const p = projectFrom(100, 200, 150, [1.618]);
  assert.ok(approx(p[0].price, 311.8));
});

test('ratioOf inverts a retracement', () => {
  assert.ok(approx(ratioOf(100, 200, 161.8), 0.382));
  assert.ok(approx(ratioOf(200, 100, 138.2), 0.382)); // 38.2% up off the low of a down-move
});

test('fibCleanliness rewards near-exact ratios', () => {
  assert.ok(approx(fibCleanliness(0.618, [0.618], 0.12), 1));
  assert.ok(fibCleanliness(0.5, [0.618], 0.12) < 0.05); // 0.118 ~ tol -> near 0
  assert.equal(fibCleanliness(0.2, [0.618], 0.12), 0);  // beyond tol -> exactly 0
  assert.ok(fibCleanliness(0.58, [0.618], 0.12) > 0.6);
});
