import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { app } from '../../src/app.js';
import { redis } from '../../src/config/redis.js';

// Phase 11 — admin dashboard login over the REAL Express app: username +
// password → httpOnly JWT cookie, then that cookie authorizes the protected
// /api/* surface (requireAdminSession) while the API key stays a fallback.

const CREDS = { username: 'admin', password: 'admin123' }; // matches .env.test

let server;
let baseUrl;

function api(path, { method = 'GET', cookie, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function sessionCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  const first = setCookie.split(';')[0];
  assert.match(first, /^admin_session=/, 'login must set the admin_session cookie');
  return first;
}

before(async () => {
  await connectTestDb();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeTestDb();
  await redis.quit();
});

describe('admin dashboard auth', () => {
  it('rejects a wrong password with a generic 401 and no cookie', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'wrong' },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'Invalid username or password');
    assert.equal(res.headers.get('set-cookie'), null);
  });

  it('rejects a missing body field with 400 VALIDATION_ERROR', async () => {
    const res = await api('/api/auth/login', { method: 'POST', body: { username: 'admin' } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'VALIDATION_ERROR');
  });

  it('logs in with the configured credentials and sets the session cookie', async () => {
    const res = await api('/api/auth/login', { method: 'POST', body: CREDS });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, username: 'admin' });
    sessionCookie(res);
  });

  it('serves /api/auth/me with the session cookie', async () => {
    const login = await api('/api/auth/login', { method: 'POST', body: CREDS });
    const cookie = sessionCookie(login);
    const res = await api('/api/auth/me', { cookie });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).username, 'admin');
  });

  it('lets the session cookie access the protected /api/appointments surface', async () => {
    const login = await api('/api/auth/login', { method: 'POST', body: CREDS });
    const cookie = sessionCookie(login);
    const res = await api('/api/appointments', { cookie });
    assert.equal(res.status, 200);
  });

  it('still accepts the API key as an alternative credential', async () => {
    const { env } = await import('../../src/config/env.js');
    const res = await fetch(`${baseUrl}/api/appointments`, {
      headers: { 'X-Admin-Api-Key': env.adminApiKey },
    });
    assert.equal(res.status, 200);
  });

  it('rejects /api/auth/me without any credential', async () => {
    const res = await api('/api/auth/me');
    assert.equal(res.status, 401);
  });

  it('logout clears the cookie so a fresh request is rejected', async () => {
    const login = await api('/api/auth/login', { method: 'POST', body: CREDS });
    const cookie = sessionCookie(login);

    const out = await api('/api/auth/logout', { method: 'POST', cookie });
    assert.equal(out.status, 200);
    const cleared = out.headers.get('set-cookie') || '';
    assert.match(cleared, /admin_session=;/);

    // Stateless JWT: the token itself stays valid until expiry, but the browser
    // cookie is gone, so a request WITHOUT the cookie must be rejected.
    const me = await api('/api/auth/me');
    assert.equal(me.status, 401);
  });
});
