import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signAdminSession, verifyAdminSession, adminCookieOptions } from '../../src/utils/session.util.js';
import { env } from '../../src/config/env.js';

// Phase 11 — admin dashboard sessions: JWT sign/verify roundtrip over the
// shared JWT_SECRET, plus the httpOnly/SameSite cookie policy. Runs without a
// DB/Redis connection (pure jwt + env).

describe('signAdminSession / verifyAdminSession', () => {
  it('signs a session the verifier accepts with the expected claims', () => {
    const token = signAdminSession({ username: 'admin' });
    const payload = verifyAdminSession(token);
    assert.equal(payload.sub, 'admin');
    assert.equal(payload.username, 'admin');
  });

  it('rejects a tampered token', () => {
    const token = signAdminSession({ username: 'admin' });
    const [header, body, sig] = token.split('.');
    const tampered = [header, body, Buffer.from('AA'.repeat(30)).toString('base64url')].join('.');
    assert.throws(() => verifyAdminSession(tampered));
  });

  it('rejects an expired token', () => {
    const token = signAdminSession({ username: 'admin' }, { expiresIn: -1 });
    assert.throws(() => verifyAdminSession(token));
  });
});

describe('adminCookieOptions', () => {
  it('is httpOnly + SameSite=Lax + cookie-path scoped', () => {
    const opts = adminCookieOptions();
    assert.equal(opts.httpOnly, true);
    assert.equal(opts.sameSite, 'lax');
    assert.equal(opts.path, '/');
    assert.equal(opts.maxAge, env.adminSessionTtlSeconds * 1000);
  });
});
