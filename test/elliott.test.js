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

test('analyze: running flat fires when B exceeds A start and targets shorter C', () => {
  // UP A: 100→160 (+60), B retraces 120% → 160-72=88, below A start of 100
  // bRet = 72/60 = 1.2, bExceedsAStart = 88 < 100 = true
  const p = [piv(100, 'L'), piv(160, 'H'), piv(88, 'L')];
  const { scenarios } = analyze(p);
  const s = scenarios.find((x) => x.id === 'running-flat');
  assert.ok(s, 'running-flat scenario should fire');
  assert.equal(s.bias, 'up'); // C goes in same direction as A (up)
  // C target at 0.618× B (72 points) from B start (88): 88 + 72*0.618 ≈ 132.5
  assert.ok(Math.abs(s.targets[1].price - (88 + 72 * 0.618)) < 0.5);
});

test('analyze: running flat does NOT fire when B stays above A start (regular/expanded flat territory)', () => {
  // UP A: 100→150 (+50), B retraces 110% → 150-55=95, still above A start of 100? No: 95<100
  // Actually let's make B stop at 105 (above A start): bRet=(150-105)/50=0.9 → below 1.0
  const p = [piv(100, 'L'), piv(150, 'H'), piv(105, 'L')]; // bRet=0.9, p[2]=105>p[0]=100
  const { scenarios } = analyze(p);
  const s = scenarios.find((x) => x.id === 'running-flat');
  assert.equal(s, undefined, 'running-flat should NOT fire when B does not exceed A start');
});

test('analyze: contracting triangle fires on 5 alternating shrinking waves', () => {
  // DOWN first wave, each subsequent smaller (×0.7)
  // p[0]=200H, p[1]=160L(A-40), p[2]=188H(B+28), p[3]=168L(C-20), p[4]=182H(D+14), p[5]=172L(E-10)
  const p = [
    piv(200, 'H'), piv(160, 'L'), piv(188, 'H'),
    piv(168, 'L'), piv(182, 'H'), piv(172, 'L'),
  ];
  const { scenarios } = analyze(p);
  const s = scenarios.find((x) => x.id === 'contracting-triangle');
  assert.ok(s, 'contracting-triangle should fire');
  assert.equal(s.bias, 'up'); // breakout opposite to first wave (down A → up breakout)
  // Target at 1.0× A (40 pts) from E (172): 172 + 40 = 212
  assert.ok(Math.abs(s.targets[1].price - 212) < 0.5);
});

test('analyze: tFlat exceedsStart correctly classifies expanded vs regular', () => {
  // DOWN A: 200→150, then B goes UP to 210 (above A start of 200) → expanded
  const pExp = [piv(200, 'H'), piv(150, 'L'), piv(210, 'H')];
  const expFlat = analyze(pExp).scenarios.find((x) => x.id === 'flat-expanded');
  assert.ok(expFlat, 'expanded flat should fire when B exceeds A start');
  // Regular: B goes only to 195 (below A start of 200)
  const pReg = [piv(200, 'H'), piv(150, 'L'), piv(195, 'H')]; // bRet=(195-150)/50=0.9
  const regFlat = analyze(pReg).scenarios.find((x) => x.id === 'flat-regular');
  assert.ok(regFlat, 'regular flat should fire when B stays below A start');
});

test('analyze: expanding triangle fires with UP breakout (same direction as A)', () => {
  // legs: +40, -38, +55, -52, +70 — alternates, all within 90% buffer, 2 clear expansions
  // i=1: 38 >= 40*0.9=36 ✓; i=2: 55 >= 38*0.9=34.2 ✓; i=3: 52 >= 55*0.9=49.5 ✓; i=4: 70 >= 52*0.9=46.8 ✓
  // clearPairs (s > prev*1.1): i=2: 55>41.8 ✓, i=4: 70>57.2 ✓ → clearPairs=2 ✓
  // p: 100L, 140H, 102L, 157H, 105L, 175H
  const p = [
    piv(100, 'L'), piv(140, 'H'), piv(102, 'L'),
    piv(157, 'H'), piv(105, 'L'), piv(175, 'H'),
  ];
  const { scenarios } = analyze(p);
  const s = scenarios.find((x) => x.id === 'expanding-triangle');
  assert.ok(s, 'expanding-triangle should fire');
  assert.equal(s.bias, 'up');
  // Target at 1.0× E (70 pts) from p[5]=175: 175+70=245
  assert.ok(Math.abs(s.targets[1].price - 245) < 0.5);
});

test('analyze: expanding triangle does NOT fire when a wave contracts >10%', () => {
  // sizes [50, 30, 65, 45, 70]: sizes[1]=30 < sizes[0]*0.9=45 → rejected
  const p = [
    piv(100, 'L'), piv(150, 'H'), piv(120, 'L'),
    piv(185, 'H'), piv(140, 'L'), piv(210, 'H'),
  ];
  const { scenarios } = analyze(p);
  const s = scenarios.find((x) => x.id === 'expanding-triangle');
  assert.equal(s, undefined, 'expanding-triangle should NOT fire');
});

test('analyze: double zigzag fires on W-X-Y structure', () => {
  // W: 100→160 (UP, +60), X: 160→135 (retrace 25/60≈41.7%), Y-A: 135→180 (UP, +45), Y-B: 180→158 (retrace 22/45≈48.9%)
  const p = [piv(100, 'L'), piv(160, 'H'), piv(135, 'L'), piv(180, 'H'), piv(158, 'L')];
  const { scenarios } = analyze(p);
  const s = scenarios.find((x) => x.id === 'double-zigzag');
  assert.ok(s, 'double-zigzag should fire');
  assert.equal(s.bias, 'up'); // W went up, so Y-C goes up
  // Y-C at 1.0× Y-A (45) from Y-B end (158): 158+45=203
  assert.ok(Math.abs(s.targets[0].price - 203) < 0.5);
});

test('analyze: double zigzag does NOT fire when X exceeds W start', () => {
  // W: 100→160 (+60), X: 160→90 (below W start of 100) → xRet=70/60≈1.167 ≥ 1.0 → reject
  const p = [piv(100, 'L'), piv(160, 'H'), piv(90, 'L'), piv(150, 'H'), piv(125, 'L')];
  const { scenarios } = analyze(p);
  const s = scenarios.find((x) => x.id === 'double-zigzag');
  assert.equal(s, undefined, 'double-zigzag should NOT fire when X exceeds W start');
});
