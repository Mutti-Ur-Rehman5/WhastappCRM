import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env, setAdminPasswordHash } from '../config/env.js';
import { AdminUser } from '../models/AdminUser.model.js';
import { sendEmail } from './email.service.js';
import { PasswordResetError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';









export const RESET_OTP_TTL_MS = 5 * 60 * 1000;
export const RESET_OTP_MAX_ATTEMPTS = 5;
const BCRYPT_COST = 10;




let adminPasswordChangedAt = 0;

export function getAdminPasswordChangedAt() {
  return adminPasswordChangedAt;
}


export function generateOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}



export const OTP_EMAIL_TEMPLATE = (otp) =>
  `Your password reset code is: ${otp}. This code expires in 5 minutes. If you didn't request this, ignore this email.`;


export const PASSWORD_CHANGED_EMAIL_TEMPLATE = () =>
  `Your password was just changed. If this wasn't you, contact support immediately.`;

export async function ensureAdminUser() {
  if (!env.adminEmail) {
    logger.warn('Admin email not configured — forgot-password disabled');
    return null;
  }

  let doc = await AdminUser.findOne({ email: env.adminEmail });
  if (!doc) {
    doc = await AdminUser.create({ email: env.adminEmail, passwordHash: env.adminPasswordHash || '' });
    logger.info('Seeded AdminUser from environment', { email: env.adminEmail });
  }

  if (doc.passwordHash) {
    setAdminPasswordHash(doc.passwordHash);
  }
  if (doc.passwordChangedAt) {
    adminPasswordChangedAt = new Date(doc.passwordChangedAt).getTime();
  }
  return doc;
}

export async function requestPasswordResetOtp({
  email,
  now = new Date(),
  newOtp = generateOtp,
  hashOtp = (otp) => bcrypt.hash(otp, BCRYPT_COST),
  sendOtpEmail = sendEmail,
} = {}) {
  const doc = await AdminUser.findOne({ email });
  if (!doc) {
    return { sent: false, email };
  }

  const otp = newOtp();
  doc.resetOtpHash = await hashOtp(otp);
  doc.resetOtpExpiresAt = new Date(now.getTime() + RESET_OTP_TTL_MS);
  doc.resetOtpAttempts = 0;
  await doc.save();

  try {
    await sendOtpEmail({
      to: doc.email,
      subject: 'Your password reset code',
      text: OTP_EMAIL_TEMPLATE(otp),
    });
  } catch (err) {
    logger.error('Failed to send password reset OTP email', {
      to: doc.email,
      err: { message: err.message },
    });
    return { sent: false, email };
  }
  return { sent: true, email };
}

export async function resetAdminPassword({
  email,
  otp,
  newPassword,
  now = new Date(),
  compareOtp = (code, hash) => bcrypt.compare(code, hash),
  hashPassword = (password) => bcrypt.hash(password, BCRYPT_COST),
  sendConfirmationEmail = sendEmail,
  changedAt = new Date(),
} = {}) {
  const doc = await AdminUser.findOne({ email });
  if (!doc || !doc.resetOtpHash || !doc.resetOtpExpiresAt) {
    throw new PasswordResetError('Invalid or expired reset code. Please request a new one.');
  }

  if (doc.resetOtpExpiresAt.getTime() < now.getTime()) {
    clearOtpFields(doc);
    await doc.save();
    throw new PasswordResetError('This reset code has expired. Please request a new one.');
  }

  if (doc.resetOtpAttempts >= RESET_OTP_MAX_ATTEMPTS) {
    clearOtpFields(doc);
    await doc.save();
    throw new PasswordResetError('Too many incorrect attempts. Please request a new code.');
  }

  const match = await compareOtp(otp, doc.resetOtpHash);
  if (!match) {
    doc.resetOtpAttempts = (doc.resetOtpAttempts || 0) + 1;
    if (doc.resetOtpAttempts >= RESET_OTP_MAX_ATTEMPTS) {
      clearOtpFields(doc);
      await doc.save();
      throw new PasswordResetError('Too many incorrect attempts. Please request a new code.');
    }
    await doc.save();
    throw new PasswordResetError('Invalid or expired reset code. Please request a new one.');
  }

  const passwordHash = await hashPassword(newPassword);
  doc.passwordHash = passwordHash;
  doc.passwordChangedAt = changedAt;
  clearOtpFields(doc);
  await doc.save();


  setAdminPasswordHash(passwordHash);
  adminPasswordChangedAt = changedAt.getTime();

  try {
    await sendConfirmationEmail({
      to: doc.email,
      subject: 'Your password was changed',
      text: PASSWORD_CHANGED_EMAIL_TEMPLATE(),
    });
  } catch (err) {


    logger.error('Failed to send password-changed confirmation email', {
      to: doc.email,
      err: { message: err.message },
    });
  }

  logger.info('Admin password reset', { to: doc.email });
  return { ok: true, email: doc.email };
}

function clearOtpFields(doc) {
  doc.resetOtpHash = null;
  doc.resetOtpExpiresAt = null;
  doc.resetOtpAttempts = 0;
}
