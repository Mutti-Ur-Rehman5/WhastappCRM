import { Router } from 'express';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { login, logout, me } from '../controllers/auth.controller.js';
import { loginRateLimiter } from '../middlewares/rateLimiter.js';
import { requireAdminSession } from '../middlewares/adminAuth.js';

// Admin dashboard auth routes (Phase 11). Mounted at /api/auth BEFORE the
// global /api guard in routes/index.js, so login/logout are reachable without
// a session; /me applies requireAdminSession itself.
const router = Router();

router.post('/login', loginRateLimiter, asyncHandler(login));
router.post('/logout', asyncHandler(logout));
router.get('/me', requireAdminSession, asyncHandler(me));

export { router };
