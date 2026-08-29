import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

const E164_RE = /^\+[1-9]\d{1,14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export const NOTIFY_EVENTS = ['booked', 'cancelled', 'rescheduled'];

export const doctorConfigSchema = new Schema(
  {
    doctorName: { type: String, required: true, trim: true },
    doctorPhone: { type: String, required: true, match: E164_RE },
    timezone: { type: String, default: 'Asia/Karachi' },
    workingHours: {
      type: [
        {
          _id: false,
          day: { type: String, enum: WEEKDAYS, required: true },
          enabled: { type: Boolean, default: true },
          start: { type: String, match: TIME_RE, required: true },
          end: { type: String, match: TIME_RE, required: true },
          slotMinutes: { type: Number, default: 15, min: 1 },
          breaks: [
            {
              _id: false,
              start: { type: String, match: TIME_RE, required: true },
              end: { type: String, match: TIME_RE, required: true },
            },
          ],
        },
      ],
      required: true,
    },
    holidays: [{ type: String, match: DATE_RE }],
    bufferMinutes: { type: Number, default: 5, min: 0 },
    // How many patients may share one grid slot. Default 1 = one appointment
    // per {doctorId, date, time} (the Appointment partial unique index is the
    // DB backstop). >1 splits capacity via Appointment.slotSeq and requires the
    // legacy 3-field unique index to be dropped (handled by the admin config
    // PUT when maxPerSlot is raised — see config.controller.js).
    maxPerSlot: { type: Number, default: 1, min: 1 },
    // Global daily cap: once this many active appointments exist for a day, any
    // further booking (WhatsApp or dashboard) for that day is rejected. Applied
    // to every working day — no per-day-of-week override (YAGNI).
    maxTokensPerDay: { type: Number, default: 20, min: 1, max: 200 },
    reminderOffsetsHours: { type: [Number], default: [24, 2] },
    googleSheetId: { type: String },
    notifyDoctorOn: { type: [String], enum: NOTIFY_EVENTS, default: ['booked', 'cancelled', 'rescheduled'] },
  },
  { timestamps: true },
);

export const DoctorConfig = models.DoctorConfig || model('DoctorConfig', doctorConfigSchema);
