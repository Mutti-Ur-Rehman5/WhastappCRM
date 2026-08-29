import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// Meta signs every webhook POST with `X-Hub-Signature-256: sha256=<hex>` —
// an HMAC-SHA256 of the raw request body using the app secret. We verify it
// BEFORE any processing and reject unverified requests with 401 (RULES.md §5).
export function verifyWebhookSignature(req, res, next) {
  const header = req.get('x-hub-signature-256');
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) {
    logger.warn('Webhook rejected: missing or malformed signature', { requestId: req.id });
    return res.sendStatus(401);
  }

  const received = header.replace(/^sha256=/i, '').toLowerCase();
  // `req.rawBody` is captured by app.js's express.json({ verify }) callback;
  // the exact bytes Meta signed must be re-hashed, not a re-serialization.
  const expected = crypto.createHmac('sha256', env.whatsapp.appSecret).update(req.rawBody ?? '').digest('hex');

  const receivedBuf = Buffer.from(received, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const valid = receivedBuf.length === expectedBuf.length && crypto.timingSafeEqual(receivedBuf, expectedBuf);

  if (!valid) {
    logger.warn('Webhook rejected: signature mismatch', { requestId: req.id });
    return res.sendStatus(401);
  }

  next();
}
