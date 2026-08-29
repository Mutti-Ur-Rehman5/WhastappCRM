import Joi from 'joi';

// Forgot-password input validation (Phase 11.5). Email is normalized to
// lowercase; the OTP is exactly 6 digits; the new password is at minimum 8
// characters (spec §2b). Weak passwords are rejected here as a clean 400
// VALIDATION_ERROR before the reset flow runs.

export const forgotPasswordSchema = Joi.object({
  // `tlds: false` — any structurally valid address is accepted. This field only
  // drives a DB lookup, and a deployment may legitimately use a reserved TLD
  // (.test/.local) or a corporate domain that is not on the public suffix list.
  email: Joi.string().trim().lowercase().email({ tlds: false }).max(254).required(),
}).unknown(false);

export const resetPasswordSchema = Joi.object({
  email: Joi.string().trim().lowercase().email({ tlds: false }).max(254).required(),
  otp: Joi.string().pattern(/^\d{6}$/).required(),
  newPassword: Joi.string().min(8).max(200).required(),
}).unknown(false);
