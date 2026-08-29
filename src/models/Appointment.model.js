import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

// E.164: optional '+', 1-3 digit country code, 1-14 digit subscriber number.
const E164_RE = /^\+[1-9]\d{1,14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
  'completed',
  'cancelled',
  'no-show',
  'rescheduled',
];

export const SHEET_SYNC_STATUSES = ['synced', 'pending', 'failed'];

export const appointmentSchema = new Schema(
  {
    tokenNo: { type: Number, required: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'DoctorConfig', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    // Denormalized for fast Sheet sync and history lookups.
    patientName: { type: String, required: true, trim: true },
    patientPhone: { type: String, required: true, match: E164_RE },
    // Dates/times stored as plain strings (no TZ bugs), slotStart as real UTC instant.
    date: { type: String, required: true, match: DATE_RE },
    time: { type: String, required: true, match: TIME_RE },
    // 0-based sequence within a {doctorId, date, time} grid slot. Always 0 when
    // maxPerSlot=1; with maxPerSlot>1 each sharing patient gets 0..N-1. It is
    // part of the unique index so capacity keeps a DB-level backstop (the old
    // 3-field unique index is dropped by the admin config PUT when capacity is
    // raised past 1 — see config.controller.js).
    slotSeq: { type: Number, default: 0, min: 0 },
    slotStart: { type: Date, required: true },
    reason: { type: String, trim: true },
    status: { type: String, enum: APPOINTMENT_STATUSES, default: 'confirmed' },
    notes: { type: String, trim: true },
    // Link to the previous appointment when this one replaces it.
    rescheduledFrom: { type: Schema.Types.ObjectId, ref: 'Appointment' },
    sheetSyncStatus: { type: String, enum: SHEET_SYNC_STATUSES, default: 'pending' },
    sheetRowId: { type: String },
    // BullMQ job ids of this appointment's delayed reminder jobs (DESIGN.md §8,
    // PHASES.md Phase 7). Removed on cancel/reschedule so a cancelled
    // appointment never fires a reminder.
    reminderJobIds: { type: [String], default: [] },
    // Phase 12 — doctor-initiated reschedule awaiting the patient's Yes/No
    // confirmation. While set, the target slot is reserved in Redis
    // (pending:rs:{doctorId}:{date}:{time}) so no other booking/reschedule can
    // take it. Cleared on confirm (Yes → this row becomes 'rescheduled'),
    // decline (No), expiry (timeout job), or when any other path cancels or
    // reschedules the appointment (see booking.service.js + rescheduleConfirmation.service.js).
    pendingReschedule: {
      _id: false,
      newDate: { type: String, match: DATE_RE },
      newTime: { type: String, match: TIME_RE },
      requestedAt: { type: Date },
      expiresAt: { type: Date },
      // Opaque lookup token embedded in the Yes/No button ids (RS_YES_<token>).
      token: { type: String },
    },
  },
  { timestamps: true },
);

// Hard DB-level double-booking safety net: only active bookings (pending or
// confirmed) count toward a slot. Cancelled/completed/no-show leave the slot
// reusable, so they are excluded from the uniqueness window. slotSeq lets
// maxPerSlot>1 share one grid slot while uniqueness per (slot, seq) still holds.
appointmentSchema.index(
  { doctorId: 1, date: 1, time: 1, slotSeq: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'confirmed'] } } },
);
appointmentSchema.index({ patientPhone: 1, date: 1 });
appointmentSchema.index({ slotStart: 1 });
// Fast admin lookups of appointments awaiting patient confirmation.
appointmentSchema.index({ 'pendingReschedule.token': 1 }, { sparse: true });
appointmentSchema.index({ 'pendingReschedule.expiresAt': 1 }, { sparse: true });

export const Appointment = models.Appointment || model('Appointment', appointmentSchema);
