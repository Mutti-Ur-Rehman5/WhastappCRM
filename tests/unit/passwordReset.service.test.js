import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateOtp,
  OTP_EMAIL_TEMPLATE,
  PASSWORD_CHANGED_EMAIL_TEMPLATE,
  RESET_OTP_TTL_MS,
  RESET_OTP_MAX_ATTEMPTS,
} from '../../src/services/passwordReset.service.js';

// Phase 11.5 — pure helpers (no DB): OTP shape, the exact email templates from
// the spec, and the security constants. No OTP/password is ever logged here and
// the templates only ever embed the code into the email body.

describe('passwordReset.service helpers', () => {
  it('generates a 6-digit numeric OTP', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i += 1) {
      const otp = generateOtp();
      assert.match(otp, /^\d{6}$/);
      seen.add(otp);
    }
    assert.ok(seen.size > 1, 'should not be constant');
  });

  it('exposes the spec OTP email template with the code and 5-minute expiry', () => {
    const text = OTP_EMAIL_TEMPLATE('123456');
    assert.match(text, /Your password reset code is: 123456/);
    assert.match(text, /expires in 5 minutes/);
    assert.match(text, /If you didn't request this, ignore this email/);
  });

  it('exposes the spec password-changed confirmation template', () => {
    const text = PASSWORD_CHANGED_EMAIL_TEMPLATE();
    assert.equal(
      text,
      "Your password was just changed. If this wasn't you, contact support immediately.",
    );
  });

  it('uses a 5-minute TTL and caps brute-force at 5 attempts', () => {
    assert.equal(RESET_OTP_TTL_MS, 5 * 60 * 1000);
    assert.equal(RESET_OTP_MAX_ATTEMPTS, 5);
  });
});
