import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { adminRateLimiter } from './rateLimiter.js';
import { verifyAdminSession, ADMIN_SESSION_SUBJECT } from '../utils/session.util.js';
import { getAdminPasswordChangedAt } from '../services/passwordReset.service.js';
import { logger } from '../utils/logger.js';










export { adminRateLimiter };

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function requireAdminApiKey(req, res, next) {
  const provided =
    req.header('x-admin-api-key') ||
    req.header('x-api-key') ||
    (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (env.adminApiKey && safeEqual(provided, env.adminApiKey)) {
    return next();
  }
  logger.warn('Admin API key rejected', { requestId: req.id });
  return res.status(401).json({ error: 'Unauthorized' });
}

export function requireAdminSession(req, res, next) {
  const token = req.cookies?.[env.adminSessionCookieName];
  if (token) {
    try {
      const payload = verifyAdminSession(token);
      const changedAt = getAdminPasswordChangedAt();
      if (payload?.sub === ADMIN_SESSION_SUBJECT && !(changedAt && payload.iat * 1000 < changedAt)) {
        req.admin = { username: payload.username };
        return next();
      }
    } catch (err) {
      logger.warn('Invalid admin session cookie', { requestId: req.id, err: err.message });
    }
  }
  return requireAdminApiKey(req, res, next);
}
