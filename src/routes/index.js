import { Router } from 'express';
import { health } from '../controllers/health.controller.js';
import { router as whatsappRouter } from './whatsapp.routes.js';
import { router as authRouter } from './auth.routes.js';
import { router as passwordResetRouter } from './passwordReset.routes.js';
import { router as appointmentRouter } from './appointment.routes.js';
import { router as configRouter } from './config.routes.js';
import { adminRateLimiter, requireAdminSession } from '../middlewares/adminAuth.js';

const router = Router();

router.get('/health', health);
router.use('/webhook/whatsapp', whatsappRouter);

// Phase 11: the dashboard login/logout endpoints are public (login is rate
// limited); /api/auth/me protects itself with requireAdminSession.
router.use('/api/auth', authRouter);

// Phase 11.5: forgot/reset password are public like login (each individually
// rate limited) — mounted before the /api guard so a logged-out admin can reach
// them. Only the two reset paths live on this router; every other /api/admin/*
// still falls through to the guarded aliases below.
router.use('/api/admin', passwordResetRouter);

// Admin surface (RULES.md §5 — no open admin endpoints): EVERY /api/* route is
// rate limited AND authenticated (session cookie OR API key) before it reaches
// a controller. Mounting the guards on the /api prefix means a future admin
// router can't be added without the protection. /health stays public so
// orchestrators can probe it.
router.use('/api', adminRateLimiter, requireAdminSession);
router.use('/api/appointments', appointmentRouter);
router.use('/api/config', configRouter);
// Phase 11 aliases: the dashboard spec paths /api/admin/* re-export the SAME
// routers (no duplicate logic — reusing the existing Phase 10 implementation).
router.use('/api/admin/appointments', appointmentRouter);
router.use('/api/admin/schedule', configRouter);

export { router };
