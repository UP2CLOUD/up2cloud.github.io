'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FileBackend } = require('../src/state/backends/file-backend');
const { acquireLock, renewLock, releaseLock, withLock, isExpired } = require('../src/state/lock');

function tmpBackend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopub-lock-'));
  return new FileBackend({ filePath: path.join(dir, 'ledger.json') });
}

test('acquires a lock on fresh state', async () => {
  const backend = tmpBackend();
  const r = await acquireLock(backend, { owner: 'runner-a', ttlSeconds: 600 });
  assert.equal(r.acquired, true);
  assert.equal(r.lock.owner, 'runner-a');
});

test('second runner cannot acquire a live lock', async () => {
  const backend = tmpBackend();
  const first = await acquireLock(backend, { owner: 'runner-a', ttlSeconds: 600 });
  assert.equal(first.acquired, true);

  const second = await acquireLock(backend, { owner: 'runner-b', ttlSeconds: 600 });
  assert.equal(second.acquired, false, 'a second concurrent runner must be refused');
  assert.equal(second.lock.owner, 'runner-a');
});

test('an expired lease is stealable so a killed runner cannot deadlock the pipeline', async () => {
  const backend = tmpBackend();
  let now = Date.parse('2026-08-10T09:00:00Z');
  const clock = () => now;

  await acquireLock(backend, { owner: 'crashed-runner', ttlSeconds: 60, clock });
  now += 61 * 1000; // lease expires; the owner never released it

  const stealer = await acquireLock(backend, { owner: 'runner-b', ttlSeconds: 60, clock });
  assert.equal(stealer.acquired, true);
  assert.equal(stealer.stolenFrom, 'crashed-runner');
});

test('release only succeeds for the owner', async () => {
  const backend = tmpBackend();
  await acquireLock(backend, { owner: 'runner-a', ttlSeconds: 600 });

  const wrong = await releaseLock(backend, 'runner-b');
  assert.equal(wrong.released, false);
  assert.equal(wrong.reason, 'not_owner');

  const right = await releaseLock(backend, 'runner-a');
  assert.equal(right.released, true);

  const after = await acquireLock(backend, { owner: 'runner-b', ttlSeconds: 600 });
  assert.equal(after.acquired, true);
});

test('renew extends the lease and fails once the lock is lost', async () => {
  const backend = tmpBackend();
  let now = Date.parse('2026-08-10T09:00:00Z');
  const clock = () => now;

  await acquireLock(backend, { owner: 'runner-a', ttlSeconds: 60, clock });
  now += 30 * 1000;
  const renewed = await renewLock(backend, 'runner-a', { ttlSeconds: 60, clock });
  assert.equal(new Date(renewed.expiresAt).getTime(), now + 60_000);

  // Someone else steals it after expiry, then the original owner tries to renew.
  now += 61 * 1000;
  await acquireLock(backend, { owner: 'runner-b', ttlSeconds: 60, clock });
  await assert.rejects(() => renewLock(backend, 'runner-a', { clock }), /Lock lost/);
});

test('withLock releases even when the body throws', async () => {
  const backend = tmpBackend();
  await assert.rejects(
    () => withLock(backend, { owner: 'runner-a', ttlSeconds: 600 }, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  const state = await backend.read();
  assert.equal(state.lock, null, 'lock must be released after a failure');
});

test('optimistic concurrency rejects a stale write', async () => {
  const backend = tmpBackend();
  const initial = await backend.read();
  await backend.write({ ...initial, lastSuccessfulPublicationAt: 'a' }, { expectedVersion: initial.version });

  await assert.rejects(
    () => backend.write({ ...initial, lastSuccessfulPublicationAt: 'b' }, { expectedVersion: initial.version }),
    (err) => err.code === 'VERSION_CONFLICT',
    'a write against a stale version must be rejected',
  );
});

test('concurrent acquisition attempts yield exactly one winner', async () => {
  const backend = tmpBackend();
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      acquireLock(backend, { owner: `runner-${i}`, ttlSeconds: 600, maxRetries: 6 }),
    ),
  );
  const winners = results.filter((r) => r.acquired);
  assert.equal(winners.length, 1, `expected exactly 1 winner, got ${winners.length}`);
});

test('isExpired treats a missing lock as expired', () => {
  assert.equal(isExpired(null), true);
  assert.equal(isExpired({ expiresAt: new Date(Date.now() + 60_000).toISOString() }), false);
  assert.equal(isExpired({ expiresAt: new Date(Date.now() - 1000).toISOString() }), true);
});
