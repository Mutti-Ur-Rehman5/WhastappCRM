import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { adminRateLimiter, requireAdminApiKey } from '../../src/middlewares/adminAuth.js';
import { env } from '../../src/config/env.js';

// Phase 9 (RULES.md §5): the admin surface is rate limited AND API-key
// secured. The limiter is exercised over a real HTTP roundtrip; the key check
// is unit-tested directly with a mock req/res.

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
  };
  return res;
}

function reqWith(key, bearer) {
  return {
    header: (h) => {
      if (h === 'x-api-key') return key;
      if (h === 'authorization') return bearer;
      return undefined;
    },
  };
}

describe('requireAdminApiKey', () => {
  it('accepts a valid x-api-key header', () => {
    let nextCalled = false;
    requireAdminApiKey(reqWith(env.adminApiKey), mockRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  it('accepts a valid Bearer token', () => {
    let nextCalled = false;
    requireAdminApiKey(reqWith(undefined, `Bearer ${env.adminApiKey}`), mockRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  it('rejects a wrong key with 401', () => {
    const res = mockRes();
    requireAdminApiKey(reqWith('nope'), res, () => assert.fail('next must not run'));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized' });
  });

  it('rejects a missing key with 401', () => {
    const res = mockRes();
    requireAdminApiKey(reqWith(undefined), res, () => assert.fail('next must not run'));
    assert.equal(res.statusCode, 401);
  });
});

describe('adminRateLimiter (real HTTP roundtrip)', () => {
  const LIMIT = 100;
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.use('/api', adminRateLimiter, (req, res) => res.json({ ok: true }));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it(`allows ${LIMIT} requests then rate-limits with 429`, async () => {
    for (let i = 0; i < LIMIT; i += 1) {
      const res = await fetch(`${baseUrl}/api`);
      assert.equal(res.status, 200, `request ${i + 1} must pass`);
    }
    const limited = await fetch(`${baseUrl}/api`);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'Too many requests' });
  });
});
