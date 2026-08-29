import Redlock from 'redlock';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import { LockUnavailableError } from '../utils/errors.js';















const slotRedlock = new Redlock([redis], {
  driftFactor: 0.01,
  retryCount: 30,
  retryDelay: 100,
  retryJitter: 100,
  automaticExtensionThreshold: 500,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRY_DELAY_BASE_MS = 150;
const RETRY_DELAY_JITTER_MS = 200;

export async function withLock(lockKey, ttlMs, fn, { redlockClient = slotRedlock, retryDelayMs = RETRY_DELAY_BASE_MS } = {}) {
  let lock = null;
  try {
    try {
      lock = await redlockClient.acquire([lockKey], ttlMs);
    } catch (err) {

      const delay = retryDelayMs + Math.floor(Math.random() * RETRY_DELAY_JITTER_MS);
      logger.warn('Slot lock busy, retrying once with jitter', { lockKey, delay, err: err.message });
      await sleep(delay);
      try {
        lock = await redlockClient.acquire([lockKey], ttlMs);
      } catch (err2) {
        logger.error('Slot lock unavailable, failing closed', { lockKey, err: err2.message });
        throw new LockUnavailableError(lockKey);
      }
    }

    return await fn(lock);
  } finally {


    if (lock) {
      await lock.release().catch((err) => logger.error('Slot lock release failed', { lockKey, err: err.message }));
    }
  }
}

export async function withLocks(lockKeys, ttlMs, fn, deps = {}) {
  const sorted = [...new Set(lockKeys)].sort();
  if (sorted.length === 0) return fn();
  const [first, ...rest] = sorted;
  return withLock(first, ttlMs, () => withLocks(rest, ttlMs, fn, deps), deps);
}
