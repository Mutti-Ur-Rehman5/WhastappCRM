import mongoose from 'mongoose';
import { APPOINTMENT_STATUSES } from './Appointment.model.js';

const { Schema, model, models } = mongoose;

const E164_RE = /^\+[1-9]\d{1,14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const patientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, match: E164_RE },
    // Lightweight, durable cross-session memory used to resolve phrases like
    // "mera appointment cancel kar do" to the most-recent-upcoming appointment.
    history: [
      {
        _id: false,
        appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment' },
        date: { type: String, match: DATE_RE },
        time: { type: String, match: TIME_RE },
        status: { type: String, enum: APPOINTMENT_STATUSES },
      },
    ],
  },
  { timestamps: true },
);

export const Patient = models.Patient || model('Patient', patientSchema);
