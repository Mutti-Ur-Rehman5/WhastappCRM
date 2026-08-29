import { Router } from 'express';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { getConfig, putConfig } from '../controllers/config.controller.js';

// Mounted at /api/config BEHIND adminRateLimiter + requireAdminApiKey
// (see src/routes/index.js). asyncHandler routes any rejection to the central
// error handler (RULES.md §4).
const router = Router();

router.get('/', asyncHandler(getConfig));
router.put('/', asyncHandler(putConfig));

export { router };
