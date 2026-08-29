import { Router } from 'express';
import { webhookRateLimiter } from '../middlewares/rateLimiter.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { verifyWebhookSignature } from '../middlewares/verifyWebhookSignature.js';
import { handleIncomingMessage, verifyWebhook } from '../webhooks/whatsapp.webhook.js';

const router = Router();

// GET is the Meta subscription handshake (no signature on this call).
router.get('/', verifyWebhook);
// POST is rate limited, signature-verified, then ingested. asyncHandler routes
// any rejection to the central error handler (RULES.md §4).
router.post('/', webhookRateLimiter, verifyWebhookSignature, asyncHandler(handleIncomingMessage));

export { router };
