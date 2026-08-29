import mongoose from 'mongoose';
import { Appointment } from '../models/Appointment.model.js';
import { MessageLog } from '../models/MessageLog.model.js';
import {
  cancelAppointment,
  checkSlotBookable,
} from '../services/booking.service.js';
import {
  getDoctorConfig,
  getRuleForDate,
  generateDaySlots,
  bufferMinutesFor,
  slotDurationForDate,
  maxTokensPerDayFor,
} from '../services/slot.service.js';
import { sendTextMessage, sendInteractiveButtons } from '../services/whatsapp.service.js';
import { enqueueSheetSync } from '../queues/sheetsSync.queue.js';
import { enqueueNotifyDoctor } from '../queues/notifyDoctor.queue.js';
import { enqueueScheduleReminders, removeReminderJobs } from '../queues/reminders.queue.js';
import { enqueueRescheduleTimeout, removeRescheduleTimeoutJob } from '../queues/rescheduleTimeout.queue.js';
import { requestRescheduleConfirmation } from '../services/rescheduleConfirmation.service.js';
import { adminCancelledAppointment, adminRescheduledAppointment } from '../prompts/templates.js';
import { getConversationLanguage } from '../services/localization.service.js';
import { logAudit } from '../services/audit.service.js';
import {
  AppointmentNotFoundError,
  AppointmentNotActiveError,
  SlotTakenError,
  ValidationError,
  PendingRescheduleExistsError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { validateOrThrow } from '../validators/validate.js';
import {
  appointmentQuerySchema,
  appointmentPatchSchema,
  rescheduleSchema,
  availableSlotsQuerySchema,
} from '../validators/appointment.validator.js';













const defaultAdminDeps = {
  enqueueSheetSync,
  enqueueNotifyDoctor,
  enqueueScheduleReminders,
  removeReminderJobs,
  sendTextMessage,
  sendInteractiveButtons,
  enqueueRescheduleTimeout,
  removeRescheduleTimeoutJob,
};
let adminDeps = { ...defaultAdminDeps };


export function _setAdminDeps(deps) {
  adminDeps = { ...defaultAdminDeps, ...deps };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireValidId(id) {
  if (!mongoose.isValidObjectId(id)) throw new ValidationError('id must be a valid ObjectId');
}

function toDoc(value) {
  return typeof value?.toObject === 'function' ? value.toObject() : value;
}

async function notifyPatientAboutAdminChange({ kind, appointment, previous }) {
  const to = appointment?.patientPhone || previous?.patientPhone;
  if (!to) return;

  const lang = await getConversationLanguage(to);

  let doctorName;
  try {
    const config = await getDoctorConfig();
    doctorName = config?.doctorName;
  } catch {
    doctorName = undefined;
  }

  const text =
    kind === 'cancelled'
      ? adminCancelledAppointment(
          {
            tokenNo: previous.tokenNo,
            date: previous.date,
            time: previous.time,
            doctorName,
          },
          lang,
        )
      : adminRescheduledAppointment(
          {
            tokenNo: appointment.tokenNo,
            date: previous.date,
            time: previous.time,
            newDate: appointment.date,
            newTime: appointment.time,
            doctorName,
          },
          lang,
        );

  try {
    const waMessageId = await adminDeps.sendTextMessage({ to, text });
    await MessageLog.create({
      phone: to,
      direction: 'out',
      channel: 'whatsapp',
      body: text,
      waMessageId: waMessageId || undefined,
    });
    logger.info('Admin change notified to patient', { kind, phone: to });
  } catch (err) {
    logger.warn('Admin change patient notification failed', { kind, phone: to, err: err.message });
  }
}

export async function listAppointments(req, res) {
  const { date, status, patientName, patientPhone, showPast, limit, offset } = validateOrThrow(
    appointmentQuerySchema,
    req.query,
    { stripUnknown: true },
  );

  const filter = {};
  if (date) filter.date = date;
  if (status) filter.status = status;
  else if (showPast !== 'true') filter.status = { $in: ['pending', 'confirmed'] };
  if (showPast !== 'true') filter.slotStart = { $gte: new Date() };
  if (patientName) filter.patientName = { $regex: escapeRegex(patientName), $options: 'i' };
  if (patientPhone) filter.patientPhone = { $regex: escapeRegex(patientPhone) };

  const [data, total] = await Promise.all([
    Appointment.find(filter).sort({ slotStart: -1 }).skip(offset).limit(limit).lean(),
    Appointment.countDocuments(filter),
  ]);

  const result = { data, pagination: { total, limit, offset } };



  if (date) {
    const config = await getDoctorConfig();
    const maxTokens = config ? maxTokensPerDayFor(config) : null;
    const dayBooked = await Appointment.countDocuments({
      date,
      status: { $in: ['pending', 'confirmed'] },
    });
    result.dailyCount = { date, booked: dayBooked, maxTokensPerDay: maxTokens };
  }

  res.json(result);
}

export async function getAppointment(req, res) {
  const { id } = req.params;
  requireValidId(id);

  const appointment = await Appointment.findById(id).lean();
  if (!appointment) {
    const err = new AppointmentNotFoundError(id);
    return res.status(404).json({ error: err.message, code: err.code });
  }


  const chain = [];
  let cursor = appointment.rescheduledFrom;
  while (cursor && chain.length < 20) {
    const previous = await Appointment.findById(cursor)
      .select('_id tokenNo date time status slotStart')
      .lean();
    if (!previous) break;
    chain.push(previous);
    cursor = previous.rescheduledFrom;
  }
  chain.reverse();

  res.json({ ...appointment, rescheduledFromChain: chain });
}

export async function patchAppointment(req, res) {
  const { id } = req.params;
  requireValidId(id);
  const body = validateOrThrow(appointmentPatchSchema, req.body);

  const appointment = await Appointment.findById(id);
  if (!appointment) {
    const err = new AppointmentNotFoundError(id);
    return res.status(404).json({ error: err.message, code: err.code });
  }

  const before = {};
  const changed = {};
  if (body.status !== undefined && body.status !== appointment.status) {
    before.status = appointment.status;
    changed.status = body.status;
  }
  if (body.notes !== undefined && body.notes !== (appointment.notes || '')) {
    before.notes = appointment.notes || '';
    changed.notes = body.notes;
  }

  if (Object.keys(changed).length === 0) {
    return res.json(appointment.toObject());
  }

  appointment.set(changed);
  await appointment.save();


  await logAudit({
    entity: 'appointment',
    entityId: appointment._id,
    action: changed.status ? (changed.notes ? 'updated_by_admin' : 'status_changed_by_admin') : 'notes_changed_by_admin',
    actor: 'admin',
    before,
    after: changed,
  });


  if (changed.status) {
    await adminDeps.enqueueSheetSync({ appointmentId: appointment._id }).catch(() => {});
  }

  logger.info('Admin updated appointment', {
    appointmentId: String(appointment._id),
    changed,
  });
  res.json(appointment.toObject());
}

export async function deleteAppointment(req, res) {
  const { id } = req.params;
  requireValidId(id);

  try {
    const appointment = await cancelAppointment({ appointmentId: id, actor: 'admin' }, adminDeps);
    await notifyPatientAboutAdminChange({ kind: 'cancelled', appointment, previous: appointment });
    res.json({ ...toDoc(appointment), cancelled: true });
  } catch (err) {
    if (err instanceof AppointmentNotFoundError) {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    if (err instanceof AppointmentNotActiveError) {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}

export async function rescheduleAppointment(req, res) {
  const { id } = req.params;
  requireValidId(id);
  const { date, time } = validateOrThrow(rescheduleSchema, req.body);

  try {
    const { appointment, pendingReschedule } = await requestRescheduleConfirmation(
      { appointmentId: id, newDate: date, newTime: time, actor: 'admin' },
      adminDeps,
    );
    res.status(201).json({
      appointment: toDoc(appointment),
      reschedulePending: true,
      pendingReschedule,
      message: 'Reschedule confirmation sent to the patient.',
    });
  } catch (err) {
    if (err instanceof AppointmentNotFoundError) {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    if (
      err instanceof AppointmentNotActiveError ||
      err instanceof SlotTakenError ||
      err instanceof PendingRescheduleExistsError
    ) {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}

export async function getAvailableSlots(req, res) {
  const { id } = req.params;
  requireValidId(id);
  const { date } = validateOrThrow(availableSlotsQuerySchema, req.query);

  const appointment = await Appointment.findById(id).lean();
  if (!appointment) {
    const err = new AppointmentNotFoundError(id);
    return res.status(404).json({ error: err.message, code: err.code });
  }

  const config = await getDoctorConfig({ doctorId: appointment.doctorId });
  if (!config) return res.json({ date, slotMinutes: 15, slots: [] });

  const rule = getRuleForDate(config, date);
  if (!rule) return res.json({ date, slotMinutes: 15, slots: [] });

  const grid = generateDaySlots(rule, bufferMinutesFor(config));
  const slots = [];
  for (const time of grid) {
    const { ok } = await checkSlotBookable({
      doctorId: appointment.doctorId,
      date,
      time,
      config,
      excludeAppointmentId: appointment._id,
    });
    if (ok) slots.push(time);
  }
  res.json({ date, slotMinutes: slotDurationForDate(config, date), slots });
}
