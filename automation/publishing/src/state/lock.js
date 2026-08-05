'use strict';

const crypto = require('node:crypto');

/**
 * Lease-based distributed lock.
 *
 * A cron-triggered pipeline that takes ~10 minutes and mutates a git repo must
 * never run twice concurrently, and the naive "is a flag set?" approach
 * deadlocks forever the first time a runner is killed mid-run. So the lock is a
 * *lease*: it carries an expiry, and an expired lease is stealable. A run that
 * outlives its lease must renew (heartbeat) or lose the right to publish.
 *
 * Acquisition is compare-and-swap on the state document's `version`, so two
 * runners reading the same unlocked state cannot both win — the loser gets a
 * VERSION_CONFLICT on write and retries, at which point it sees the winner's
 * lease.
 */

class LockError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LockError';
    this.code = code;
  }
}

function nowMs(clock) {
  return clock ? clock() : Date.now();
}

function isExpired(lock, clock) {
  if (!lock || !lock.expiresAt) return true;
  return new Date(lock.expiresAt).getTime() <= nowMs(clock);
}

/**
 * Try to take the lock. Returns `{ acquired, lock, state }`.
 * `acquired: false` means someone else holds a live lease — the caller should
 * exit cleanly, not error.
 */
async function acquireLock(backend, options = {}) {
  const {
    owner = `${process.env.GITHUB_RUN_ID || 'local'}-${crypto.randomBytes(4).toString('hex')}`,
    ttlSeconds = 45 * 60,
    maxRetries = 3,
    clock = null,
    reason = 'publish',
  } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const state = await backend.read();
    const existing = state.lock;

    if (existing && !isExpired(existing, clock)) {
      return { acquired: false, lock: existing, state };
    }

    const stolen = Boolean(existing && isExpired(existing, clock));
    const t = nowMs(clock);
    const lock = {
      owner,
      reason,
      acquiredAt: new Date(t).toISOString(),
      expiresAt: new Date(t + ttlSeconds * 1000).toISOString(),
      heartbeatAt: new Date(t).toISOString(),
      stolenFrom: stolen ? existing.owner : null,
    };

    try {
      const written = await backend.write({ ...state, lock }, { expectedVersion: state.version });
      return { acquired: true, lock, state: written, stolenFrom: lock.stolenFrom };
    } catch (err) {
      if (err.code === 'VERSION_CONFLICT') {
        // Someone moved the document underneath us — re-read and reassess.
        // Small jittered backoff avoids two runners lock-stepping forever.
        await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 150)));
        continue;
      }
      throw err;
    }
  }

  throw new LockError(
    `Failed to acquire lock after ${maxRetries + 1} attempts (persistent version conflict)`,
    'LOCK_CONTENTION',
  );
}

/** Extend our lease. Throws if we no longer own it — the run must then abort. */
async function renewLock(backend, owner, options = {}) {
  const { ttlSeconds = 45 * 60, clock = null } = options;
  const state = await backend.read();

  if (!state.lock || state.lock.owner !== owner) {
    throw new LockError(
      `Lock lost: expected owner "${owner}", found "${state.lock ? state.lock.owner : 'none'}"`,
      'LOCK_LOST',
    );
  }

  const t = nowMs(clock);
  const lock = {
    ...state.lock,
    heartbeatAt: new Date(t).toISOString(),
    expiresAt: new Date(t + ttlSeconds * 1000).toISOString(),
  };
  await backend.write({ ...state, lock }, { expectedVersion: state.version });
  return lock;
}

/**
 * Release the lock. Only the owner may release, so a runner that lost its lease
 * to a steal cannot delete the new holder's lock on its way out.
 */
async function releaseLock(backend, owner) {
  const state = await backend.read();
  if (!state.lock) return { released: false, reason: 'no_lock' };
  if (state.lock.owner !== owner) {
    return { released: false, reason: 'not_owner', heldBy: state.lock.owner };
  }
  await backend.write({ ...state, lock: null }, { expectedVersion: state.version });
  return { released: true };
}

/** Run `fn` while holding the lock, releasing it even if `fn` throws. */
async function withLock(backend, options, fn) {
  const result = await acquireLock(backend, options);
  if (!result.acquired) return { acquired: false, lock: result.lock, value: undefined };
  try {
    const value = await fn({
      owner: result.lock.owner,
      renew: (opts) => renewLock(backend, result.lock.owner, { ...options, ...opts }),
    });
    return { acquired: true, lock: result.lock, value };
  } finally {
    await releaseLock(backend, result.lock.owner).catch(() => {
      /* lease will expire on its own; never mask the original error */
    });
  }
}

module.exports = { acquireLock, renewLock, releaseLock, withLock, isExpired, LockError };
