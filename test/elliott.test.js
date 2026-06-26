import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkImpulse, checkPartialImpulse, analyze } from '../src/core/elliott.js';

let t = 0;
const piv = (price, type, tentative = false) =>
  ({ index: t, time: 1000 + t++, price, type, tentative });

test('checkImpulse validates a clean 5-wave up impulse', () => {
  const p = [
    piv(100, 'L'), piv(130, 'H'), piv(115, 'L'),
    piv(200, 'H'), piv(170, 'L'), piv(250, 'H'),
  ];
  const r = checkImpulse(p);
  assert.equal(r.valid, true);
  assert.equal(r.dir, 1);
  assert.deepEqual(r.rules, { r1: true, r2: true, r3: true });
});

test('checkImpulse rejects wave-1/wave-4 overlap', () => {
  // wave 4 low (120) dips below wave 1 high (130) -> overlap, invalid
  const p = [
    piv(100, 'L'), piv(130, 'H'), piv(115, 'L'),
    piv(200, 'H'), piv(120, 'L'), piv(250, 'H'),
  ];
  assert.equal(checkImpulse(p).rules.r3, false);
  assert.equal(checkImpulse(p).valid, false);
});

test('analyze: completed impulse yields a corrective scenario', () => {
  const p = [
    piv(100, 'L'), piv(130, 'H'), piv(115, 'L'),
    piv(200, 'H'), piv(170, 'L'), piv(250, 'H'),
  ];
  const { scenarios } = analyze(p);
  const s = scenarios.find((x) => x.id === 'impulse-complete');
  assert.ok(s, 'impulse-complete scenario should fire');
  assert.equal(s.bias, 'down');
  assert.equal(s.invalidation, 250);
  assert.equal(s.targets.length, 3);
});

test('analyze: 1-2 structure yields a wave-3 scenario projecting up', () => {
  const p = [piv(100, 'L'), piv(130, 'H'), piv(115, 'L', true)];
  const { scenarios } = analyze(p);
  // tentative last pivot is excluded from structure but the two confirmed legs remain
  const confirmed = p.filter((x) => !x.tentative);
  assert.equal(confirmed.length, 2);
  // with only 2 confirmed pivots, wave-3 needs 3 confirmed -> use all-confirmed case instead
  const p2 = [piv(100, 'L'), piv(130, 'H'), piv(115, 'L')];
  const s = analyze(p2).scenarios.find((x) => x.id === 'wave-3');
  assert.ok(s, 'wave-3 scenario should fire');
  assert.equal(s.bias, 'up');
  assert.equal(s.invalidation, 100);
  // wave 3 = 1.618 x wave1(30) from 115 = 163.54
  assert.ok(Math.abs(s.targets[0].price - 163.54) < 0.1);
});

test('checkPartialImpulse accepts waves 1-2-3-4', () => {
  const p = [piv(100, 'L'), piv(130, 'H'), piv(115, 'L'), piv(200, 'H'), piv(170, 'L')];
  const r = checkPartialImpulse(p);
  assert.equal(r.valid, true);
  assert.equal(r.dir, 1);
});
