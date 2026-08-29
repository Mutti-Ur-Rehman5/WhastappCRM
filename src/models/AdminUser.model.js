import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

// Admin dashboard credential + forgot-password state (Phase 11.5). A SINGLE
// row — this clinic has one admin, the doctor. The password hash is seeded
// from ADMIN_PASSWORD_HASH on first boot and becomes the source of truth once a
// password reset has happened (see passwordReset.service.js), so a reset
// survives restarts. OTP state is stored HASHED (bcrypt) and single-use; the
// plaintext code only ever travels by email.
export const adminUserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, default: '' },
    resetOtpHash: { type: String, default: null },
    resetOtpExpiresAt: { type: Date, default: null },
    resetOtpAttempts: { type: Number, default: 0 },
    // Monotonic marker bumped on every successful reset; requireAdminSession
    // rejects JWTs issued before it, forcing a re-login after a reset.
    passwordChangedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const AdminUser = models.AdminUser || model('AdminUser', adminUserSchema);
