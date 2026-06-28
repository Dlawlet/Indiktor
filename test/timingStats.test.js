// Tests — ① empirical leg-duration windows from resolved snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingWindows, windowFor, MIN_TIMING_N } from '../src/core/timingStats.js';

// A resolved snapshot with one hypothesis whose anchor indices encode leg lengths.
function hitSnap(tf, type, legA, legB, legC) {
  return {
    tf,
    hypotheses: [{
      outcome: 'hit', typeBranch: [type],
      anchor: {
        O: { index: 0 }, A: { index: legA },
        B: { index: legA + legB }, C: { index: legA + legB + legC },
      },
    }],
  };
}

test('timingWindows: omits segments below MIN_TIMING_N', () => {
  const few = Array.from({ length: MIN_TIMING_N - 1 }, () => hitSnap('1h', 'regular', 10, 9, 10));
  assert.deepEqual(timingWindows(few), {});
});

test('timingWindows: builds [p20,p80] windows once enough hits exist', () => {
  // legB/legA ratios spread around ~1.0; legC/legA around ~1.0
  const snaps = [];
  for (let i = 0; i < MIN_TIMING_N + 4; i++) {
    const legB = 8 + (i % 5);   // 8..12
    const legC = 9 + (i % 4);   // 9..12
    snaps.push(hitSnap('4h', 'regular', 10, legB, legC));
  }
  const w = timingWindows(snaps);
  const seg = w['4h|regular'];
  assert.ok(seg, 'segment present');
  assert.ok(seg.b[0] <= seg.b[1], 'b window ordered');
  assert.ok(seg.b[0] >= 0.8 && seg.b[1] <= 1.2, `b window in range, got ${seg.b}`);
  assert.ok(seg.c && seg.c[0] <= seg.c[1], 'c window present + ordered');
  assert.ok(seg.n >= MIN_TIMING_N);
});

test('timingWindows: only hits inform the window', () => {
  const snaps = Array.from({ length: MIN_TIMING_N }, () => hitSnap('1h', 'running', 10, 10, 10));
  snaps.push({ tf: '1h', hypotheses: [{ outcome: 'miss', typeBranch: ['running'],
    anchor: { O: { index: 0 }, A: { index: 10 }, B: { index: 999 }, C: { index: 1000 } } }] });
  const w = timingWindows(snaps);
  // The miss with a huge legB must not widen the window.
  assert.ok(w['1h|running'].b[1] <= 1.0001, 'miss excluded from window');
});

test('windowFor: prefers (tf,type), falls back to (tf), else null', () => {
  const windows = { '1h|regular': { b: [0.5, 1.5] }, '1h': { b: [0.4, 1.6] } };
  assert.deepEqual(windowFor(windows, '1h', { typeBranch: ['regular'] }).b, [0.5, 1.5]);
  assert.deepEqual(windowFor(windows, '1h', { typeBranch: ['running'] }).b, [0.4, 1.6]);
  assert.equal(windowFor(windows, '4h', { typeBranch: ['regular'] }), null);
  assert.equal(windowFor(null, '1h', {}), null);
});
