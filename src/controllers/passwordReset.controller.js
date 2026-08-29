import { validateOrThrow } from '../validators/validate.js';
import { forgotPasswordSchema, resetPasswordSchema } from '../validators/passwordReset.validator.js';
import { requestPasswordResetOtp, resetAdminPassword } from '../services/passwordReset.service.js';

// Forgot-password endpoints (Phase 11.5). Public (like login), each guarded by
// its own per-email rate limiter in the route file. Deliberate security
// choices: forgot-password ALWAYS answers with the same generic message (no
// account enumeration), and reset-password never reveals whether the OTP was
// wrong vs unknown — only expired / exhausted get distinct guidance.

// Spec §2a — identical response whether or not the email is registered.
export const FORGOT_PASSWORD_GENERIC_MESSAGE = 'If this email is registered, an OTP has been sent.';

/** POST /api/admin/forgot-password — requests an OTP email (rate limited). */
export async function forgotPassword(req, res) {
  const { email } = validateOrThrow(forgotPasswordSchema, req.body);
  await requestPasswordResetOtp({ email });
  res.json({ message: FORGOT_PASSWORD_GENERIC_MESSAGE });
}

/** POST /api/admin/reset-password — validates OTP and updates the password. */
export async function resetPassword(req, res) {
  const { email, otp, newPassword } = validateOrThrow(resetPasswordSchema, req.body);
  await resetAdminPassword({ email, otp, newPassword });
  res.json({ ok: true, message: 'Your password has been updated. Please sign in with your new password.' });
}
