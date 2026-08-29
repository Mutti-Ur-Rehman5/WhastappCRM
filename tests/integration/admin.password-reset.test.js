import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { app } from '../../src/app.js';
import { redis } from '../../src/config/redis.js';
import { env } from '../../src/config/env.js';
import { AdminUser } from '../../src/models/AdminUser.model.js';
import { getEmailTransport } from '../../src/services/email.service.js';
import { signAdminSession } from '../../src/utils/session.util.js';
import { FORGOT_PASSWORD_GENERIC_MESSAGE } from '../../src/controllers/passwordReset.controller.js';

// Phase 11.5 — forgot-password over the REAL Express app. SMTP is faked via the
// email.service transport seam (getEmailTransport(factory)), so no real email
// goes out: the OTP is captured from the in-memory send and used to complete
// the reset end-to-end. The rate limiters and attempt caps run for real.

const ADMIN_EMAIL = env.adminEmail; // admin@clinic.test from .env.test

const sentEmails = [];
getEmailTransport(() => ({
  sendMail: async (mail) => {
    sentEmails.push(mail);
    return { messageId: 'test-message-id' };
  },
}));

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
  return setCookie.split(';')[0];
}

function lastOtp() {
  const last = sentEmails.at(-1);
  const match = last?.text?.match(/Your password reset code is: (\d{6})/);
  return match?.[1];
}

function resetEmailCount() {
  return sentEmails.filter((mail) => mail.subject === 'Your password was changed').length;
}

async function seedAdmin({ email = ADMIN_EMAIL, passwordHash = env.adminPasswordHash } = {}) {
  await AdminUser.deleteOne({ email });
  return AdminUser.create({ email, passwordHash });
}

before(async () => {
  await connectTestDb();
  await AdminUser.deleteMany({});
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await AdminUser.deleteMany({});
  await closeTestDb();
  await redis.quit();
});

describe('admin forgot-password API', () => {
  it('forgot-password for a registered email returns the generic message and emails a 6-digit OTP', async () => {
    await seedAdmin();
    sentEmails.length = 0;

    const res = await api('/api/admin/forgot-password', {
      method: 'POST',
      body: { email: ADMIN_EMAIL },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).message, FORGOT_PASSWORD_GENERIC_MESSAGE);

    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].to, ADMIN_EMAIL);
    assert.equal(sentEmails[0].subject, 'Your password reset code');
    assert.match(lastOtp(), /^\d{6}$/);

    const doc = await AdminUser.findOne({ email: ADMIN_EMAIL });
    assert.ok(doc.resetOtpHash, 'OTP is stored hashed, never plain text');
    assert.notEqual(doc.resetOtpHash, lastOtp(), 'the plaintext OTP must not be stored');
    assert.ok(doc.resetOtpExpiresAt > new Date(Date.now() - 1000), 'OTP expiry is set in the future');
    assert.equal(doc.resetOtpAttempts, 0);
  });

  it('forgot-password for an UNregistered email returns the SAME generic message and sends nothing', async () => {
    sentEmails.length = 0;
    const res = await api('/api/admin/forgot-password', {
      method: 'POST',
      body: { email: 'nobody@example.com' },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).message, FORGOT_PASSWORD_GENERIC_MESSAGE);
    assert.equal(sentEmails.length, 0);
  });

  it('rejects a weak new password with a clear 400 VALIDATION_ERROR', async () => {
    const res = await api('/api/admin/reset-password', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, otp: '123456', newPassword: 'short' },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'VALIDATION_ERROR');
  });

  it('rejects a wrong OTP without revealing the correct one, counts the attempt, then succeeds with the right code', async () => {
    await seedAdmin();
    sentEmails.length = 0;
    await api('/api/admin/forgot-password', { method: 'POST', body: { email: ADMIN_EMAIL } });
    const correctOtp = lastOtp();
    assert.match(correctOtp, /^\d{6}$/);

    const wrong = await api('/api/admin/reset-password', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, otp: correctOtp === '111111' ? '222222' : '111111', newPassword: 'brand-new-secret' },
    });
    assert.equal(wrong.status, 400);
    const wrongBody = await wrong.json();
    assert.match(wrongBody.error, /Invalid or expired reset code/);
    assert.ok(!JSON.stringify(wrongBody).includes(correctOtp), 'the correct OTP must never leak in a response');

    let doc = await AdminUser.findOne({ email: ADMIN_EMAIL });
    assert.equal(doc.resetOtpAttempts, 1, 'every wrong try increments the attempt counter');

    // Session issued BEFORE the reset must be invalidated once the password changes.
    const staleToken = signAdminSession({ username: 'admin' });

    const ok = await api('/api/admin/reset-password', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, otp: correctOtp, newPassword: 'brand-new-secret' },
    });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);

    doc = await AdminUser.findOne({ email: ADMIN_EMAIL });
    assert.ok(await bcrypt.compare('brand-new-secret', doc.passwordHash), 'new password is bcrypt-hashed and saved');
    assert.equal(doc.resetOtpHash, null, 'OTP is cleared after a successful reset (single-use)');
    assert.equal(doc.resetOtpAttempts, 0);
    assert.ok(doc.passwordChangedAt, 'passwordChangedAt is persisted for session invalidation');

    assert.equal(resetEmailCount(), 1, 'a confirmation email is sent');

    // Replaying the SAME code must now fail (single-use).
    const replay = await api('/api/admin/reset-password', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, otp: correctOtp, newPassword: 'another-secret-123' },
    });
    assert.equal(replay.status, 400);

    // The untouched login route now validates against the NEW password.
    const oldLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { username: env.adminUsername, password: 'admin123' },
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { username: env.adminUsername, password: 'brand-new-secret' },
    });
    assert.equal(newLogin.status, 200);

    // The pre-reset JWT is now stale and rejected.
    const me = await api('/api/auth/me', { cookie: staleToken });
    assert.equal(me.status, 401);
  });

  it('rejects an EXPIRED OTP and clears the stored code', async () => {
    await seedAdmin();
    const doc = await AdminUser.findOne({ email: ADMIN_EMAIL });
    doc.resetOtpHash = await bcrypt.hash('654321', 10);
    doc.resetOtpExpiresAt = new Date(Date.now() - 60_000);
    doc.resetOtpAttempts = 0;
    await doc.save();

    const res = await api('/api/admin/reset-password', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, otp: '654321', newPassword: 'expired-test-123' },
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /expired/);

    const after = await AdminUser.findOne({ email: ADMIN_EMAIL });
    assert.equal(after.resetOtpHash, null, 'an expired code is cleared so a fresh request is required');
  });

  it('rejects the reset once attempts are exhausted and invalidates the code', async () => {
    await seedAdmin();
    const doc = await AdminUser.findOne({ email: ADMIN_EMAIL });
    doc.resetOtpHash = await bcrypt.hash('654321', 10);
    doc.resetOtpExpiresAt = new Date(Date.now() + 60_000);
    doc.resetOtpAttempts = 5; // already maxed out
    await doc.save();

    const res = await api('/api/admin/reset-password', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, otp: '654321', newPassword: 'exhausted-test-123' },
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Too many incorrect attempts/);

    const after = await AdminUser.findOne({ email: ADMIN_EMAIL });
    assert.equal(after.resetOtpHash, null, 'the code is invalidated after exceeding max attempts');
  });

  it('rate-limits forgot-password to 3 requests per email per hour', async () => {
    sentEmails.length = 0;
    // Tests 1 and 4 already used 2 of the 3 hourly allowance for ADMIN_EMAIL.
    const third = await api('/api/admin/forgot-password', { method: 'POST', body: { email: ADMIN_EMAIL } });
    assert.equal(third.status, 200);

    const blocked = await api('/api/admin/forgot-password', { method: 'POST', body: { email: ADMIN_EMAIL } });
    assert.equal(blocked.status, 429);
    // Only the allowed 3rd request actually sent an OTP email this test.
    assert.equal(sentEmails.filter((mail) => mail.subject === 'Your password reset code').length, 1);
  });
});
