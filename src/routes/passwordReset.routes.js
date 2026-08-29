import { Router } from 'express';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { forgotPassword, resetPassword } from '../controllers/passwordReset.controller.js';
import { forgotPasswordRateLimiter, resetPasswordRateLimiter } from '../middlewares/rateLimiter.js';

// Forgot/reset password routes (Phase 11.5). Mounted at /api/admin in
// routes/index.js BEFORE the global /api guard, so a logged-out admin can reach
// them — same rationale as the public /api/auth login route. Each endpoint is
// individually rate limited (per-email) to blunt OTP-spam and guessing.
const router = Router();

router.post('/forgot-password', forgotPasswordRateLimiter, asyncHandler(forgotPassword));
router.post('/reset-password', resetPasswordRateLimiter, asyncHandler(resetPassword));

export { router };
