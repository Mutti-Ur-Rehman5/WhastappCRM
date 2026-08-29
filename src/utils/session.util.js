import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// Admin dashboard sessions (Phase 11): a short-lived JWT carried in an httpOnly
// cookie so the browser JS never touches the token. Same JWT_SECRET that the
// admin API was already built around (required in production). Signing/verify
// fail closed when the secret is absent — no silent anonymous sessions.

export const ADMIN_SESSION_SUBJECT = 'admin';

/** Signs a fresh admin session token (claims: sub 'admin', username). */
export function signAdminSession({ username }, { expiresIn = env.adminSessionTtlSeconds } = {}) {
  if (!env.jwtSecret) throw new Error('JWT_SECRET not configured');
  return jwt.sign({ sub: ADMIN_SESSION_SUBJECT, username }, env.jwtSecret, { expiresIn });
}

/** Verifies a session token and returns its payload, or throws on expiry/bad secret. */
export function verifyAdminSession(token) {
  if (!env.jwtSecret) throw new Error('JWT_SECRET not configured');
  return jwt.verify(token, env.jwtSecret);
}

/**
 * Cookie options for the admin session (httpOnly + Secure).
 * SameSite: the admin dashboard can be hosted separately (e.g. Vercel) while
 * this API stays on another origin (Render), so cross-site requests must carry
 * the cookie. `none` is only legal over HTTPS, so prod (HTTPS) uses `none`
 * with the mandatory `Secure`; localhost/dev stays `lax` (same-origin proxy).
 */
export function adminCookieOptions() {
  return {
    httpOnly: true,
    sameSite: env.isProduction ? 'none' : 'lax',
    secure: env.isProduction,
    maxAge: env.adminSessionTtlSeconds * 1000,
    path: '/',
  };
}
