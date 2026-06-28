// Tests — ① provenance param set + stable hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, buildParams, hashParams, segmentKey } from '../src/core/params.js';

test('buildParams: merges overrides onto defaults', () => {
  const p = buildParams({ k: 5, minConf: 0.75 });
  assert.equal(p.k, 5);
  assert.equal(p.minConf, 0.75);
  assert.equal(p.beam, DEFAULT_PARAMS.beam, 'untouched defaults preserved');
});

test('hashParams: deterministic for identical params', () => {
  assert.equal(hashParams(buildParams({ k: 3 })), hashParams(buildParams({ k: 3 })));
});

test('hashParams: independent of key insertion order', () => {
  const a = hashParams({ k: 3, minConf: 0.55, beam: 4 });
  const b = hashParams({ beam: 4, k: 3, minConf: 0.55 });
  assert.equal(a, b);
});

test('hashParams: different params → different hash', () => {
  assert.notEqual(hashParams(buildParams({ k: 3 })), hashParams(buildParams({ k: 4 })));
  assert.notEqual(hashParams(buildParams({ minConf: 0.55 })), hashParams(buildParams({ minConf: 0.65 })));
});

test('hashParams: 8 hex chars', () => {
  assert.match(hashParams(buildParams()), /^[0-9a-f]{8}$/);
});

test('segmentKey: TF only vs TF+type', () => {
  assert.equal(segmentKey('1h'), '1h');
  assert.equal(segmentKey('1h', 'regular'), '1h|regular');
});
