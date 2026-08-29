import Joi from 'joi';
import { APPOINTMENT_STATUSES } from '../models/Appointment.model.js';

// Joi schemas for /api/appointments (RULES.md §5 — untrusted admin input).
// Pagination is offset-based: `offset` = how many rows to skip, `limit` = page
// size (default 50, max 200). The list response carries the matched `total` so
// an admin UI can render page counts without an extra count request.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// patientName / patientPhone filters are case-insensitive substring matches
// (documented in the controller); we only constrain length here.
export const appointmentQuerySchema = Joi.object({
  date: Joi.string().pattern(DATE_RE, 'date must be formatted YYYY-MM-DD'),
  status: Joi.string()
    .valid(...APPOINTMENT_STATUSES)
    .messages({ 'any.only': `status must be one of: ${APPOINTMENT_STATUSES.join(', ')}` }),
  patientName: Joi.string().trim().max(100),
  patientPhone: Joi.string().trim().max(20),
  // When absent/`false`, the dashboard's live view hides history and past
  // slots: the list defaults to active statuses (pending/confirmed) and only
  // upcoming appointments (slotStart >= now). Pass `showPast=true` to include
  // everything.
  showPast: Joi.string().valid('true', 'false'),
  limit: Joi.number().integer().min(1).max(200).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

// PATCH is intentionally narrow (DESIGN.md §9, RULES.md §3): only `status` and
// `notes` are admin-editable. `.unknown(false)` means any attempt to touch
// date/time/patient/token fields is rejected with a 400 instead of silently
// ignored — the same restriction the Sheets inbound sync enforces (Phase 6).
export const appointmentPatchSchema = Joi.object({
  status: Joi.string()
    .valid(...APPOINTMENT_STATUSES)
    .messages({ 'any.only': `status must be one of: ${APPOINTMENT_STATUSES.join(', ')}` }),
  notes: Joi.string().max(2000).allow(''),
})
  .unknown(false)
  .min(1);

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Phase 11 — admin dashboard reschedule. Structural slot changes go through
// the locked rescheduleAppointment pipeline, never PATCH (RULES.md §3).
export const rescheduleSchema = Joi.object({
  date: Joi.string().pattern(DATE_RE, 'date must be formatted YYYY-MM-DD').required(),
  time: Joi.string().pattern(TIME_RE, 'time must be formatted HH:mm').required(),
}).unknown(false);

// Phase 11 — available-slot picker for the reschedule modal.
export const availableSlotsQuerySchema = Joi.object({
  date: Joi.string().pattern(DATE_RE, 'date must be formatted YYYY-MM-DD').required(),
}).unknown(false);
