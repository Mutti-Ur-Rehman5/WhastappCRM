import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { redis } from '../../src/config/redis.js';
import { withLocks } from '../../src/services/lock.service.js';
import { LockUnavailableError } from '../../src/utils/errors.js';

// withLocks (Phase 5 reschedule): multi-key acquisition in a consistent sorted
// order so concurrent multi-slot operations can never cross-lock and deadlock.
// Pure unit test — a fake Redlock client records the keys it is asked to
// acquire and hands back a tiny lock object, so no Redis is needed. (lock.service
// itself imports config/redis.js, so the shared client must still be quit in
// after() or the test process never exits.)

function stubRedlock({ failKeys = new Set() } = {}) {  const acquired = [];
  const released = [];
  const lock = {
    release: async () => {
      released.push(lock._keys);
    },
  };
  return {
    lock,
    acquired,
    released,
    async acquire(keys, ttl) {
      acquired.push({ keys, ttl });
      if (keys.some((k) => failKeys.has(k))) {
        const err = new Error('lock busy');
        err.name = 'LockError';
        throw err;
      }
      lock._keys = keys;
      return lock;
    },
  };
}

after(async () => {
  await redis.quit();
});

describe('withLocks (sorted multi-key acquisition)', () => {
  it('acquires keys in alphabetical order, runs fn, releases in finally', async () => {
    const client = stubRedlock();
    let ran = false;
    const value = await withLocks(['lock:slot:x:2099-01-05:09:15', 'lock:slot:x:2099-01-05:09:00'], 10_000, async () => {
      ran = true;
      return 42;
    }, { redlockClient: client, retryDelayMs: 1 });

    assert.equal(value, 42);
    assert.equal(ran, true);
    assert.deepEqual(
      client.acquired.map((a) => a.keys),
      [
        ['lock:slot:x:2099-01-05:09:00'],
        ['lock:slot:x:2099-01-05:09:15'],
      ],
      'locks are taken smallest key first, one at a time',
    );
    assert.equal(client.released.length, 2, 'every acquired lock is released');
  });

  it('deduplicates repeated keys (old slot === new slot) into a single acquisition', async () => {
    const client = stubRedlock();
    await withLocks(['lock:slot:x:09:00', 'lock:slot:x:09:00'], 10_000, async () => 'ok', {
      redlockClient: client,
      retryDelayMs: 1,
    });
    assert.equal(client.acquired.length, 1);
    assert.equal(client.released.length, 1);
  });

  it('releases already-acquired locks when a later acquisition fails (no leaked locks)', async () => {
    const client = stubRedlock({ failKeys: new Set(['lock:slot:x:09:15']) });
    await assert.rejects(
      withLocks(['lock:slot:x:09:00', 'lock:slot:x:09:15'], 10_000, async () => 'never', {
        redlockClient: client,
        retryDelayMs: 1,
      }),
      LockUnavailableError,
    );
    assert.equal(client.acquired.length, 3, 'first key once + failing key attempted twice (initial + jitter retry)');
    assert.equal(client.released.length, 1, 'only the actually-held first lock is released before the failure propagates');
  });

  it('releases locks when fn throws, and propagates the error', async () => {
    const client = stubRedlock();
    await assert.rejects(
      withLocks(['lock:slot:x:09:00', 'lock:slot:x:09:15'], 10_000, async () => {
        throw new Error('boom');
      }, { redlockClient: client, retryDelayMs: 1 }),
      /boom/,
    );
    assert.equal(client.released.length, 2, 'locks released on error');
  });

  it('with an empty key list just runs fn without touching Redis', async () => {
    const client = stubRedlock();
    const value = await withLocks([], 10_000, async () => 'empty', { redlockClient: client });
    assert.equal(value, 'empty');
    assert.equal(client.acquired.length, 0);
  });
});
