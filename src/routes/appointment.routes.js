import { Router } from 'express';
import { asyncHandler } from '../middlewares/errorHandler.js';
import {
  listAppointments,
  getAppointment,
  patchAppointment,
  deleteAppointment,
  rescheduleAppointment,
  getAvailableSlots,
} from '../controllers/appointment.controller.js';

// Mounted at /api/appointments BEHIND adminRateLimiter + requireAdminApiKey
// (see src/routes/index.js). asyncHandler routes any rejection to the central
// error handler (RULES.md §4).
const router = Router();

router.get('/', asyncHandler(listAppointments));
// Phase 11: the available-slots picker is registered BEFORE /:id so a literal
// `:id/available-slots` path is never swallowed by the detail route.
router.get('/:id/available-slots', asyncHandler(getAvailableSlots));
router.get('/:id', asyncHandler(getAppointment));
router.patch('/:id', asyncHandler(patchAppointment));
// Phase 11: structural slot change through the locked reschedule pipeline.
router.patch('/:id/reschedule', asyncHandler(rescheduleAppointment));
router.delete('/:id', asyncHandler(deleteAppointment));

export { router };
