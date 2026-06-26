import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, SnapshotStore, createStore } from '../src/feedback/store.js';

const record = (id, ts) => ({
  id,
  snapshot: { id, ts, asset: 'BTCUSDT', timeframe: '1d', priceAtAnalysis: 100, scenarios: [] },
  outcomes: { 'wave-3': { outcome: 'pending', resolver: 'auto' } },
});

test('MemoryStore round-trips put/get/all/delete', async () => {
  const store = new MemoryStore();
  assert.deepEqual(await store.all(), []);

  await store.put(record('a', 100));
  await store.put(record('b', 200));

  const a = await store.get('a');
  assert.equal(a.id, 'a');
  assert.equal(a.snapshot.asset, 'BTCUSDT');
  assert.equal(typeof a.updatedTs, 'number');

  const all = await store.all();
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'b'); // newest snapshot ts first

  await store.delete('a');
  assert.equal(await store.get('a'), undefined);
  assert.equal((await store.all()).length, 1);
});

test('MemoryStore clones on write so stored state is not mutable by reference', async () => {
  const store = new MemoryStore();
  const rec = record('x', 1);
  await store.put(rec);
  rec.outcomes['wave-3'].outcome = 'target-hit'; // mutate the original after put

  const got = await store.get('x');
  assert.equal(got.outcomes['wave-3'].outcome, 'pending'); // unaffected

  got.snapshot.asset = 'HACKED'; // mutate the returned copy
  const again = await store.get('x');
  assert.equal(again.snapshot.asset, 'BTCUSDT'); // store still clean
});

test('MemoryStore put requires an id', async () => {
  const store = new MemoryStore();
  await assert.rejects(() => store.put({ snapshot: {} }), /id required/);
});

test('createStore falls back to MemoryStore when IndexedDB is absent (Node)', () => {
  const store = createStore();
  assert.ok(store instanceof MemoryStore);
  assert.ok(store instanceof SnapshotStore);
});

test('abstract SnapshotStore methods throw', () => {
  const s = new SnapshotStore();
  assert.throws(() => s.put({}), /not implemented/);
  assert.throws(() => s.get('x'), /not implemented/);
  assert.throws(() => s.all(), /not implemented/);
  assert.throws(() => s.delete('x'), /not implemented/);
});
