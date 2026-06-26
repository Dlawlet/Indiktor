import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFlatPattern } from '../src/core/scanner.js';

const p = (price, type = 'L', time = 0) => ({ price, type, time });

test('classifyFlatPattern detects regular flat in bull direction', () => {
  const a = p(100, 'L', 1);
  const b = p(150, 'H', 2);
  const c = p(110, 'L', 3); // bRet = 0.8, no exceed
  const out = classifyFlatPattern(a, b, c);
  assert.ok(out);
  assert.equal(out.type, 'regular');
  assert.equal(out.market, 'bull');
  assert.equal(out.name, 'BULL Regular Flat');
});

test('classifyFlatPattern detects regular flat in bear direction', () => {
  const a = p(200, 'H', 1);
  const b = p(150, 'L', 2);
  const c = p(190, 'H', 3); // bRet = 0.8, no exceed
  const out = classifyFlatPattern(a, b, c);
  assert.ok(out);
  assert.equal(out.type, 'regular');
  assert.equal(out.market, 'bear');
  assert.equal(out.name, 'BEAR Regular Flat');
});

test('classifyFlatPattern detects contracting flat in bull direction', () => {
  const out = classifyFlatPattern(p(100), p(150), p(130)); // bRet = 0.4
  assert.ok(out);
  assert.equal(out.type, 'contracting');
  assert.equal(out.market, 'bull');
});

test('classifyFlatPattern detects contracting flat in bear direction', () => {
  const out = classifyFlatPattern(p(200), p(150), p(170)); // bRet = 0.4
  assert.ok(out);
  assert.equal(out.type, 'contracting');
  assert.equal(out.market, 'bear');
});

test('classifyFlatPattern detects expanding flat in bull direction', () => {
  const out = classifyFlatPattern(p(100), p(150), p(45)); // bRet = 2.1, exceeds A start
  assert.ok(out);
  assert.equal(out.market, 'bull');
  assert.equal(out.type, 'expanding');
});

test('classifyFlatPattern detects running flat and expanding split by 1.236 threshold', () => {
  const running = classifyFlatPattern(p(100), p(150), p(45 + 43.5)); // c=88.5, bRet=1.23
  assert.ok(running);
  assert.equal(running.type, 'running');

  const expanding = classifyFlatPattern(p(100), p(150), p(35)); // bRet=2.3
  assert.ok(expanding);
  assert.equal(expanding.type, 'expanding');
});

test('classifyFlatPattern detects running/expanding in bear direction', () => {
  const running = classifyFlatPattern(p(200), p(150), p(211)); // bRet=1.22, exceed
  assert.ok(running);
  assert.equal(running.market, 'bear');
  assert.equal(running.type, 'running');

  const expanding = classifyFlatPattern(p(200), p(150), p(230)); // bRet=1.6, exceed
  assert.ok(expanding);
  assert.equal(expanding.market, 'bear');
  assert.equal(expanding.type, 'expanding');
});

test('classifyFlatPattern returns null for non-flat zone', () => {
  // bRet = 0.68 falls in intentional gray zone between contracting and regular
  const out = classifyFlatPattern(p(100), p(150), p(116));
  assert.equal(out, null);
});
