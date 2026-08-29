import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// Blunts webhook abuse without tripping over Meta's legitimate retry bursts.
// The webhook is publicly reachable, so it must be rate limited (RULES.md §5).
// Limits are env-tunable (WEBHOOK_RATE_LIMIT / WEBHOOK_RATE_LIMIT_WINDOW_MS)
// with production defaults of 300 req/min.
export const webhookRateLimiter = rateLimit({
  windowMs: env.webhookRateLimitWindowMs,
  limit: env.webhookRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Webhook rate limit exceeded', { requestId: req.id });
    res.status(429).json({ error: 'Too many requests' });
  },
});

// Sensible default for the admin API (Phase 10 mounts /api/* behind it). The
// admin surface is not patient-facing, so a tighter limit than the webhook is
// appropriate; it prevents a leaked key from being brute-forced fast.
export const adminRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Admin rate limit exceeded', { requestId: req.id });
    res.status(429).json({ error: 'Too many requests' });
  },
});

// Phase 11 dashboard login: much tighter than the admin API limiter — the
// login endpoint is publicly reachable and password guessing must be slow.
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Login rate limit exceeded', { requestId: req.id });
    res.status(429).json({ error: 'Too many login attempts' });
  },
});

// Forgot/reset password limiters (Phase 11.5) are keyed by the SUBMITTED email
// (falling back to the client IP), so a spammer can neither hammer one address
// from many IPs nor spray many accounts from one IP. Express.json has already
// parsed the body by the time these run (they are attached after the body
// parser in the route definitions).

function resetEmailKeyGenerator(req) {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return email || req.ip || 'unknown';
}

// Spec §2a — OTP-spam abuse cap: max 3 reset requests per email per hour.
export const forgotPasswordRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resetEmailKeyGenerator,
  handler: (req, res) => {
    logger.warn('Forgot-password rate limit exceeded', { requestId: req.id });
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
  },
});

// Spec §4 — same approach on the reset endpoint (guessing attempts are ALSO
// capped server-side by resetOtpAttempts). Generous enough for retries after
// typos, tight enough to blunt brute force.
export const resetPasswordRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resetEmailKeyGenerator,
  handler: (req, res) => {
    logger.warn('Password reset rate limit exceeded', { requestId: req.id });
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
  },
});
