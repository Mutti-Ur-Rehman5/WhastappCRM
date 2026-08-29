import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../../src/utils/retry.util.js';

const alwaysFail = () => Promise.reject(new Error('boom'));
const errWithStatus = (status) => {
  const err = new Error(`http ${status}`);
  err.response = { status };
  return Promise.reject(err);
};

describe('withRetry', () => {
  it('returns the value from the first successful attempt', async () => {
    const calls = [];
    const result = await withRetry(() => {
      calls.push(1);
      return Promise.resolve('done');
    });
    assert.equal(result, 'done');
    assert.equal(calls.length, 1);
  });

  it('retries then succeeds within the attempt budget', async () => {
    const calls = [];
    const result = await withRetry(() => {
      calls.push(1);
      if (calls.length < 3) return Promise.reject(new Error('flaky'));
      return Promise.resolve('recovered');
    }, { baseDelayMs: 5, jitterMs: 0 });
    assert.equal(result, 'recovered');
    assert.equal(calls.length, 3);
  });

  it('gives up after max attempts and rethrows the last error', async () => {
    await assert.rejects(
      () => withRetry(alwaysFail, { attempts: 4, baseDelayMs: 5, jitterMs: 0 }),
      /boom/,
    );
  });

  it('respects shouldRetry: non-retryable errors are not retried', async () => {
    const calls = [];
    await assert.rejects(
      () =>
        withRetry(() => {
          calls.push(1);
          return errWithStatus(400);
        }, {
          attempts: 5,
          baseDelayMs: 5,
          jitterMs: 0,
          shouldRetry: (err) => err.response?.status >= 500,
        }),
      /http 400/,
    );
    assert.equal(calls.length, 1, 'must fail fast on 4xx');
  });

  it('retries retryable HTTP statuses (429, 5xx) per shouldRetry', async () => {
    const calls = [];
    const result = await withRetry(() => {
      calls.push(1);
      if (calls.length === 1) return errWithStatus(429);
      if (calls.length === 2) return errWithStatus(503);
      return Promise.resolve('ok');
    }, {
      baseDelayMs: 5,
      jitterMs: 0,
      shouldRetry: (err) => err.response?.status === 429 || err.response?.status >= 500,
    });
    assert.equal(result, 'ok');
    assert.equal(calls.length, 3);
  });

  it('backs off exponentially between attempts', async () => {
    const started = Date.now();
    await assert.rejects(
      () => withRetry(alwaysFail, { attempts: 4, baseDelayMs: 10, factor: 2, jitterMs: 0 }),
      /boom/,
    );
    // delays are 10 + 20 + 40 = 70ms minimum (jitter disabled)
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 70, `expected >=70ms of backoff, got ${elapsed}ms`);
  });
});
