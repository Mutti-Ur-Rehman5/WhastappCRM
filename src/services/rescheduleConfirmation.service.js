import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Appointment } from '../models/Appointment.model.js';
import { MessageLog } from '../models/MessageLog.model.js';
import { redis } from '../config/redis.js';
import { pendingRescheduleKey } from './pendingReschedule.marker.js';
import { withLocks } from './lock.service.js';
import {
  BOOKING_LOCK_TTL_MS,
  slotLockKey,
  checkSlotBookable,
  rescheduleAppointment,
  noopEnqueueSheetSync,
  noopEnqueueNotifyDoctor,
  noopEnqueueScheduleReminders,
  noopRemoveReminderJobs,
} from './booking.service.js';
import { getDoctorConfig } from './slot.service.js';
import { logAudit } from './audit.service.js';
import { sendTextMessage, sendInteractiveButtons } from './whatsapp.service.js';
import { getConversationLanguage } from './localization.service.js';
import {
  rescheduleProposal,
  rescheduleConfirmedPatient,
  rescheduleDeclinedPatient,
  rescheduleExpiredPatient,
  rescheduleDoctorResult,
  rescheduleSlotNoLongerAvailable,
} from '../prompts/templates.js';
import {
  AppointmentNotFoundError,
  AppointmentNotActiveError,
  SlotTakenError,
  ValidationError,
  PendingRescheduleExistsError,
  PendingRescheduleResolvedError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';























const noopEnqueueRescheduleTimeout = async () => null;
const noopRemoveRescheduleTimeoutJob = async () => null;

export const RS_YES_PREFIX = 'RS_YES_';
export const RS_NO_PREFIX = 'RS_NO_';


export function parseRescheduleButtonId(buttonId) {
  if (typeof buttonId !== 'string') return null;
  if (buttonId.startsWith(RS_YES_PREFIX)) return { answer: 'yes', token: buttonId.slice(RS_YES_PREFIX.length) };
  if (buttonId.startsWith(RS_NO_PREFIX)) return { answer: 'no', token: buttonId.slice(RS_NO_PREFIX.length) };
  return null;
}

export async function requestRescheduleConfirmation({ appointmentId, newDate, newTime, actor = 'admin' }, deps = {}) {
  const {
    confirmationTimeoutMs = env.rescheduleConfirmationTimeoutMs,
    now = () => new Date(),
    enqueueRescheduleTimeout = noopEnqueueRescheduleTimeout,
    sendInteractiveButtons: sendButtons = sendInteractiveButtons,
    correlationId,
  } = deps;

  if (!appointmentId || !newDate || !newTime) {
    throw new ValidationError('appointmentId, newDate and newTime are required to propose a reschedule');
  }

  const existing = await Appointment.findById(appointmentId).lean();
  if (!existing) throw new AppointmentNotFoundError(appointmentId);
  if (existing.status !== 'confirmed') throw new AppointmentNotActiveError(appointmentId, existing.status);

  const config = await getDoctorConfig({ doctorId: existing.doctorId });
  if (!config) throw new ValidationError('no doctor schedule configured for reschedule');

  const proposedAt = now();
  const expiresAt = new Date(proposedAt.getTime() + confirmationTimeoutMs);
  const token = crypto.randomBytes(16).toString('hex');
  const proposalText = rescheduleProposal(
    { date: existing.date, time: existing.time, newDate, newTime },
    await getConversationLanguage(existing.patientPhone),
  );

  const appointment = await withLocks(
    [slotLockKey(existing.doctorId, existing.date, existing.time), slotLockKey(existing.doctorId, newDate, newTime)],
    BOOKING_LOCK_TTL_MS,
    async () => {


      const availability = await checkSlotBookable({
        doctorId: existing.doctorId,
        date: newDate,
        time: newTime,
        config,
        excludeAppointmentId: existing._id,
      });
      if (!availability.ok) throw new SlotTakenError(newDate, newTime, null, { reason: availability.reason });



      const reserved = await redis.set(
        pendingRescheduleKey(existing.doctorId, newDate, newTime),
        String(existing._id),
        'PX',
        confirmationTimeoutMs,
        'NX',
      );
      if (!reserved) throw new SlotTakenError(newDate, newTime, null, { reason: 'pending_reschedule' });

      const session = await mongoose.startSession();
      try {
        let updated;
        await session.withTransaction(async () => {
          const current = await Appointment.findById(appointmentId).session(session);
          if (!current) throw new AppointmentNotFoundError(appointmentId);
          if (current.status !== 'confirmed') throw new AppointmentNotActiveError(appointmentId, current.status);


          if (current.pendingReschedule?.token) throw new PendingRescheduleExistsError(appointmentId);

          current.pendingReschedule = { newDate, newTime, requestedAt: proposedAt, expiresAt, token };
          await current.save({ session });

          await logAudit(
            {
              entity: 'appointment',
              entityId: current._id,
              action: 'reschedule_requested',
              actor,
              before: { tokenNo: current.tokenNo, date: current.date, time: current.time, status: 'confirmed' },
              after: {
                tokenNo: current.tokenNo,
                date: current.date,
                time: current.time,
                newDate,
                newTime,
                status: 'confirmed',
              },
            },
            { session },
          );
          updated = current;
        });
        return updated;
      } catch (err) {


        await redis.del(pendingRescheduleKey(existing.doctorId, newDate, newTime));
        throw err;
      } finally {
        await session.endSession();
      }
    },
  );



  try {
    const waMessageId = await sendButtons({
      to: existing.patientPhone,
      body: proposalText,
      buttons: [
        { id: `${RS_YES_PREFIX}${token}`, title: 'Yes' },
        { id: `${RS_NO_PREFIX}${token}`, title: 'No' },
      ],
    });
    await MessageLog.create({
      phone: existing.patientPhone,
      direction: 'out',
      channel: 'whatsapp',
      body: proposalText,
      waMessageId: waMessageId || undefined,
    });
  } catch (err) {
    logger.warn('Reschedule proposal message failed to send', {
      appointmentId: String(appointmentId),
      phone: existing.patientPhone,
      err: { message: err.message },
    });
  }

  try {
    await enqueueRescheduleTimeout({ token, delayMs: confirmationTimeoutMs, correlationId });
  } catch (err) {
    logger.warn('Failed to enqueue reschedule-timeout job', {
      appointmentId: String(appointmentId),
      err: { message: err.message },
    });
  }

  return { appointment, pendingReschedule: appointment.pendingReschedule };
}

async function logSend({ to, text, waMessageId, correlationId }) {
  try {
    await MessageLog.create({
      phone: to,
      direction: 'out',
      channel: 'whatsapp',
      body: text,
      waMessageId: waMessageId || undefined,
    });
  } catch (err) {
    logger.warn('Failed to persist outbound MessageLog', { to, err: { message: err.message } });
  }
}

async function notifyPatientAndDoctor({ outcome, pending, appointment, sendText }) {
  const to = pending.patientPhone;
  const lang = await getConversationLanguage(to);
  const patientText =
    outcome === 'confirmed'
      ? rescheduleConfirmedPatient({ tokenNo: pending.tokenNo, newDate: pending.pendingReschedule.newDate, newTime: pending.pendingReschedule.newTime }, lang)
      : outcome === 'declined'
        ? rescheduleDeclinedPatient({ tokenNo: pending.tokenNo, date: pending.date, time: pending.time }, lang)
        : rescheduleExpiredPatient({ tokenNo: pending.tokenNo, date: pending.date }, lang);
  try {
    const waMessageId = await sendText({ to, text: patientText });
    await logSend({ to, text: patientText, waMessageId });
  } catch (err) {
    logger.warn('Reschedule outcome patient message failed', {
      appointmentId: String(pending._id),
      outcome,
      phone: to,
      err: { message: err.message },
    });
  }

  let config;
  try {
    config = await getDoctorConfig({ doctorId: pending.doctorId });
  } catch {
    config = null;
  }
  if (config?.doctorPhone) {
    const doctorText = rescheduleDoctorResult({
      result: outcome === 'confirmed' ? 'accepted' : outcome === 'declined' ? 'declined' : 'expired',
      patientName: appointment?.patientName || pending.patientName,
      patientPhone: appointment?.patientPhone || pending.patientPhone,
      tokenNo: pending.tokenNo,
      newDate: pending.pendingReschedule.newDate,
      newTime: pending.pendingReschedule.newTime,
    });
    try {
      const waMessageId = await sendText({ to: config.doctorPhone, text: doctorText });
      await logSend({ to: config.doctorPhone, text: doctorText, waMessageId });
    } catch (err) {
      logger.warn('Reschedule outcome doctor message failed', {
        appointmentId: String(pending._id),
        outcome,
        err: { message: err.message },
      });
    }
  }
}

export async function confirmReschedule(token, deps = {}) {
  const {
    sendTextMessage: sendText = sendTextMessage,
    removeRescheduleTimeoutJob = noopRemoveRescheduleTimeoutJob,
    enqueueSheetSync = noopEnqueueSheetSync,
    enqueueNotifyDoctor = noopEnqueueNotifyDoctor,
    enqueueScheduleReminders = noopEnqueueScheduleReminders,
    removeReminderJobs = noopRemoveReminderJobs,
    correlationId,
  } = deps;

  const pending = await Appointment.findOne({ 'pendingReschedule.token': token })
    .select('_id doctorId status pendingReschedule patientPhone patientName tokenNo')
    .lean();
  if (!pending?.pendingReschedule) return { skipped: true, reason: 'no_pending' };

  const { newDate, newTime } = pending.pendingReschedule;
  let appointment;
  let previous;
  try {
    ({ appointment, previous } = await rescheduleAppointment(
      { appointmentId: pending._id, newDate, newTime, actor: 'patient', requirePendingToken: token },
      { enqueueSheetSync, enqueueNotifyDoctor, enqueueScheduleReminders, removeReminderJobs, correlationId },
    ));
  } catch (err) {

    if (err instanceof PendingRescheduleResolvedError) {
      return { skipped: true, reason: 'no_pending' };
    }



    if (err instanceof SlotTakenError) {
      try {
        const fallbackText = rescheduleSlotNoLongerAvailable(await getConversationLanguage(pending.patientPhone));
        const waMessageId = await sendText({ to: pending.patientPhone, text: fallbackText });
        await logSend({ to: pending.patientPhone, text: fallbackText, waMessageId });
      } catch (sendErr) {
        logger.warn('Reschedule slot-lost fallback message failed', {
          appointmentId: String(pending._id),
          err: { message: sendErr.message },
        });
      }
      logger.warn('Reschedule confirmation failed: slot no longer available', {
        appointmentId: String(pending._id),
        newDate,
        newTime,
      });
      return { failed: true, reason: 'slot_taken' };
    }
    throw err;
  }

  await removeRescheduleTimeoutJob(token);
  await notifyPatientAndDoctor({ outcome: 'confirmed', pending, appointment, sendText });

  return { confirmed: true, appointment, previous };
}

async function resolvePendingWithoutMove({ token, outcome, deps }) {
  const {
    sendTextMessage: sendText = sendTextMessage,
    removeRescheduleTimeoutJob = noopRemoveRescheduleTimeoutJob,
    now = () => new Date(),
    correlationId,
  } = deps;

  const pending = await Appointment.findOne({ 'pendingReschedule.token': token }).lean();
  if (!pending?.pendingReschedule) return { skipped: true, reason: 'no_pending' };
  const { newDate, newTime } = pending.pendingReschedule;

  const resolved = await withLocks(
    [slotLockKey(pending.doctorId, pending.date, pending.time), slotLockKey(pending.doctorId, newDate, newTime)],
    BOOKING_LOCK_TTL_MS,
    async () => {
      const session = await mongoose.startSession();
      try {
        let result;
        await session.withTransaction(async () => {
          const current = await Appointment.findById(pending._id).session(session);
          if (!current?.pendingReschedule?.token) {
            result = { skipped: true, reason: 'no_pending' };
            return;
          }
          if (String(current.pendingReschedule.token) !== token) {
            result = { skipped: true, reason: 'no_pending' };
            return;
          }
          if (current.status !== 'confirmed') {
            result = { skipped: true, reason: 'not_confirmed' };
            return;
          }
          if (outcome === 'expired') {
            const currentNow = now();
            if (!current.pendingReschedule.expiresAt || current.pendingReschedule.expiresAt > currentNow) {
              const remainingMs = current.pendingReschedule.expiresAt
                ? current.pendingReschedule.expiresAt.getTime() - currentNow.getTime()
                : 0;
              result = { skipped: true, reason: 'not_yet_expired', remainingMs };
              return;
            }
          }

          await redis.del(pendingRescheduleKey(pending.doctorId, newDate, newTime));
          await Appointment.updateOne({ _id: current._id }, { $unset: { pendingReschedule: 1 } }).session(session);

          await logAudit(
            {
              entity: 'appointment',
              entityId: current._id,
              action: outcome === 'declined' ? 'reschedule_declined' : 'reschedule_expired',
              actor: outcome === 'declined' ? 'patient' : 'system',
              before: {
                tokenNo: current.tokenNo,
                date: current.date,
                time: current.time,
                newDate,
                newTime,
                status: 'confirmed',
              },
              after: { tokenNo: current.tokenNo, date: current.date, time: current.time, status: 'confirmed' },
            },
            { session },
          );
          result = { resolved: true, appointment: current };
        });
        return result;
      } finally {
        await session.endSession();
      }
    },
  );

  if (resolved.skipped) return resolved;

  await removeRescheduleTimeoutJob(token);
  await notifyPatientAndDoctor({ outcome, pending, appointment: pending, sendText });

  return resolved;
}

export async function declineReschedule(token, deps = {}) {
  return resolvePendingWithoutMove({ token, outcome: 'declined', deps });
}

export async function expireReschedule(token, deps = {}) {
  return resolvePendingWithoutMove({ token, outcome: 'expired', deps });
}
