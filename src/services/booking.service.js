import mongoose from 'mongoose';
import { Appointment } from '../models/Appointment.model.js';
import { Patient } from '../models/Patient.model.js';
import { logAudit, logAuditMany } from './audit.service.js';
import { withLock, withLocks } from './lock.service.js';
import { redis } from '../config/redis.js';
import { pendingRescheduleHeld, pendingRescheduleKey } from './pendingReschedule.marker.js';
import { nextToken } from '../utils/token.util.js';
import { clinicNow, toUtcInstant } from '../utils/datetime.util.js';
import {
  getDoctorConfig,
  isSlotValid,
  isBufferClash,
  slotDurationForDate,
  bufferMinutesFor,
  maxPerSlotFor,
  maxTokensPerDayFor,
} from './slot.service.js';
import {
  SlotTakenError,
  ValidationError,
  AppointmentNotFoundError,
  AppointmentNotActiveError,
  PendingRescheduleResolvedError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';











export const BOOKING_LOCK_TTL_MS = 10_000;
export const ACTIVE_STATUSES = ['pending', 'confirmed'];







export const noopEnqueueSheetSync = async () => null;
export const noopEnqueueNotifyDoctor = async () => null;
export const noopEnqueueNotifyPatientConfirmation = async () => null;
export const noopEnqueueScheduleReminders = async () => null;
export const noopRemoveReminderJobs = async () => ({ removed: 0 });

async function enqueueSheetSyncAfterCommit(appointment, enqueueSheetSync = noopEnqueueSheetSync, correlationId) {
  try {
    await enqueueSheetSync({ appointmentId: appointment._id, correlationId });
  } catch (err) {



    logger.error('Failed to enqueue sheets-sync job', {
      appointmentId: String(appointment._id),
      err: { message: err.message },
    });
  }
}





async function enqueueAfterCommit(fn, context) {
  try {
    return await fn();
  } catch (err) {
    logger.error('Failed to enqueue post-commit job', { ...context, err: { message: err.message } });
    return null;
  }
}

export function slotLockKey(doctorId, date, time) {
  return `lock:slot:${doctorId}:${date}:${time}`;
}

async function assertPendingRescheduleFree({ doctorId, date, time, excludeAppointmentId }) {
  const held = await pendingRescheduleHeld({ doctorId, date, time, excludeAppointmentId });
  if (held) throw new SlotTakenError(date, time, null, { reason: 'pending_reschedule' });
}

export async function releasePendingReschedule({ appointmentId, doctorId, newDate, newTime, session }) {
  if (newDate && newTime) {
    await redis.del(pendingRescheduleKey(doctorId, newDate, newTime));
  }
  if (appointmentId && session) {
    await Appointment.updateOne(
      { _id: appointmentId },
      { $unset: { pendingReschedule: 1 } },
      { session },
    ).session(session);
  }
}

export function evaluateSlotClash(activeSameDay, { time, capacity, slotMinutes, bufferMinutes, excludeAppointmentId }) {
  const sameTimeCount = activeSameDay.filter((a) => a.time === time).length;
  if (sameTimeCount >= capacity) return { taken: true, reason: 'capacity', sameTimeCount };

  const bufferClash = activeSameDay.find(
    (a) =>
      a.time !== time &&
      String(a._id) !== String(excludeAppointmentId) &&
      isBufferClash(a.time, time, slotMinutes, bufferMinutes),
  );
  if (bufferClash) return { taken: true, reason: 'buffer', sameTimeCount };

  return { taken: false, reason: null, sameTimeCount };
}

async function assertSlotBookable({ doctorId, date, time, config, session, excludeBufferAppointmentId, excludePendingAppointmentId }) {
  const ruleCheck = isSlotValid(config, date, time);
  if (!ruleCheck.ok) throw new SlotTakenError(date, time, null, { reason: ruleCheck.reason });
  if (toUtcInstant(date, time) <= new Date()) throw new SlotTakenError(date, time, null, { reason: 'in_the_past' });




  await assertPendingRescheduleFree({ doctorId, date, time, excludeAppointmentId: excludePendingAppointmentId });

  const activeSameDay = await Appointment.find({
    doctorId,
    date,
    status: { $in: ACTIVE_STATUSES },
  })
    .select({ _id: 1, time: 1 })
    .session(session)
    .lean();





  const maxTokens = maxTokensPerDayFor(config);
  if (activeSameDay.length >= maxTokens) {
    throw new SlotTakenError(date, time, null, { reason: 'day_full' });
  }

  const clash = evaluateSlotClash(activeSameDay, {
    time,
    capacity: maxPerSlotFor(config),
    slotMinutes: slotDurationForDate(config, date),
    bufferMinutes: bufferMinutesFor(config),
    excludeAppointmentId: excludeBufferAppointmentId,
  });
  if (clash.taken) throw new SlotTakenError(date, time, null, { reason: clash.reason });

  return clash.sameTimeCount;
}

export async function checkSlotBookable({ doctorId, date, time, config, excludeAppointmentId }, { todayRef, nowTime } = {}) {
  const cfg = config || (await getDoctorConfig({ doctorId }));
  if (!cfg) return { ok: false, reason: 'no_config' };

  const ruleCheck = isSlotValid(cfg, date, time);
  if (!ruleCheck.ok) return { ok: false, reason: ruleCheck.reason };

  const now = clinicNow();
  const today = todayRef ?? now.format('YYYY-MM-DD');
  const currentTime = nowTime ?? now.format('HH:mm');
  if (date < today || (date === today && time <= currentTime)) return { ok: false, reason: 'in_the_past' };



  const pendingHeld = await pendingRescheduleHeld({ doctorId, date, time, excludeAppointmentId });
  if (pendingHeld) return { ok: false, reason: 'pending_reschedule' };

  const activeSameDay = await Appointment.find({
    doctorId,
    date,
    status: { $in: ACTIVE_STATUSES },
  })
    .select({ _id: 1, time: 1 })
    .lean();




  const maxTokens = maxTokensPerDayFor(cfg);
  if (activeSameDay.length >= maxTokens) return { ok: false, reason: 'day_full' };

  const clash = evaluateSlotClash(activeSameDay, {
    time,
    capacity: maxPerSlotFor(cfg),
    slotMinutes: slotDurationForDate(cfg, date),
    bufferMinutes: bufferMinutesFor(cfg),
    excludeAppointmentId,
  });
  return clash.taken ? { ok: false, reason: clash.reason } : { ok: true, reason: null };
}

export function isDuplicateKeyError(err) {
  return Boolean(err && (err.code === 11000 || err.code === 11001));
}

export async function bookAppointment({ doctorId, date, time, patient, reason }, deps = {}) {
  if (!doctorId || !date || !time || !patient?._id) {
    throw new ValidationError('doctorId, date, time and a patient with _id are required to book');
  }

  const config = await getDoctorConfig({ doctorId });
  if (!config) throw new ValidationError('no doctor schedule configured for booking');

  const lockKey = `lock:slot:${doctorId}:${date}:${time}`;
  const appointment = await withLock(lockKey, BOOKING_LOCK_TTL_MS, async () => {
    const session = await mongoose.startSession();
    try {
      let appointment;
      await session.withTransaction(async () => {




        const slotSeq = await assertSlotBookable({ doctorId, date, time, config, session });

        const tokenNo = await nextToken(session);
        [appointment] = await Appointment.create(
          [
            {
              tokenNo,
              doctorId,
              date,
              time,
              slotSeq,
              patientId: patient._id,
              patientName: patient.name,
              patientPhone: patient.phone,
              reason,
              status: 'confirmed',
              slotStart: toUtcInstant(date, time),
            },
          ],
          { session },
        );




        await logAudit(
          {
            entity: 'appointment',
            entityId: appointment._id,
            action: 'booked',
            actor: 'patient',
            after: {
              tokenNo,
              date,
              time,
              patientName: patient.name,
              patientPhone: patient.phone,
              status: 'confirmed',
              slotStart: appointment.slotStart.toISOString(),
            },
          },
          { session },
        );
      });
      return appointment;
    } catch (err) {


      if (isDuplicateKeyError(err)) {
        logger.warn('Booking rejected by unique index safety net (lock bypassed or expired)', {
          doctorId,
          date,
          time,
          err: err.message,
        });
        throw new SlotTakenError(date, time, err);
      }
      throw err;
    } finally {
      await session.endSession();
    }
  });



  const {
    enqueueSheetSync = noopEnqueueSheetSync,
    enqueueNotifyDoctor = noopEnqueueNotifyDoctor,
    enqueueNotifyPatientConfirmation = noopEnqueueNotifyPatientConfirmation,
    enqueueScheduleReminders = noopEnqueueScheduleReminders,
    correlationId,
  } = deps;
  await enqueueSheetSyncAfterCommit(appointment, enqueueSheetSync, correlationId);
  await enqueueAfterCommit(
    () => enqueueNotifyDoctor({ appointmentId: appointment._id, event: 'booked', correlationId }),
    { op: 'notify-doctor:booked', appointmentId: String(appointment._id) },
  );
  await enqueueAfterCommit(
    () => enqueueNotifyPatientConfirmation({ appointmentId: appointment._id, correlationId }),
    { op: 'notify-patient-confirmation', appointmentId: String(appointment._id) },
  );
  await enqueueAfterCommit(
    () => enqueueScheduleReminders({ appointmentId: appointment._id, correlationId }),
    { op: 'schedule-reminders', appointmentId: String(appointment._id) },
  );
  return appointment;
}

export async function findUpcomingAppointments({ patientPhone, from = new Date() }) {
  return Appointment.find({
    patientPhone,
    status: 'confirmed',
    slotStart: { $gte: from },
  })
    .sort({ slotStart: 1 })
    .lean();
}

async function syncPatientHistory({ patientId, entries, session }) {
  if (!entries.length) return;
  const appointmentIds = entries.map((e) => e.appointmentId);
  await Patient.updateOne(
    { _id: patientId },
    { $pull: { history: { appointmentId: { $in: appointmentIds } } } },
    { session },
  );
  await Patient.updateOne({ _id: patientId }, { $push: { history: { $each: entries } } }, { session });
}

export async function rescheduleAppointment({ appointmentId, newDate, newTime, actor = 'patient', requirePendingToken }, deps = {}) {
  if (!appointmentId || !newDate || !newTime) {
    throw new ValidationError('appointmentId, newDate and newTime are required to reschedule');
  }



  const existing = await Appointment.findById(appointmentId).lean();
  if (!existing) throw new AppointmentNotFoundError(appointmentId);
  if (existing.status !== 'confirmed') throw new AppointmentNotActiveError(appointmentId, existing.status);

  const oldLockKey = slotLockKey(existing.doctorId, existing.date, existing.time);
  const newLockKey = slotLockKey(existing.doctorId, newDate, newTime);

  const config = await getDoctorConfig({ doctorId: existing.doctorId });
  if (!config) throw new ValidationError('no doctor schedule configured for reschedule');

  const { appointment, previous } = await withLocks(
    [oldLockKey, newLockKey],
    BOOKING_LOCK_TTL_MS,
    async () => {
      const session = await mongoose.startSession();
      try {
        let appointment;
        let previous;
        await session.withTransaction(async () => {
          const old = await Appointment.findById(appointmentId).session(session);
          if (!old) throw new AppointmentNotFoundError(appointmentId);


          if (old.status !== 'confirmed') throw new AppointmentNotActiveError(appointmentId, old.status);




          if (requirePendingToken && (!old.pendingReschedule?.token || String(old.pendingReschedule.token) !== String(requirePendingToken))) {
            throw new PendingRescheduleResolvedError(appointmentId);
          }






          const slotSeq = await assertSlotBookable({
            doctorId: old.doctorId,
            date: newDate,
            time: newTime,
            config,
            session,
            excludeBufferAppointmentId: old._id,
            excludePendingAppointmentId: old._id,
          });

          const tokenNo = await nextToken(session);
          [appointment] = await Appointment.create(
            [
              {
                tokenNo,
                doctorId: old.doctorId,
                patientId: old.patientId,
                patientName: old.patientName,
                patientPhone: old.patientPhone,
                date: newDate,
                time: newTime,
                slotSeq,
                slotStart: toUtcInstant(newDate, newTime),
                reason: old.reason,
                status: 'confirmed',
                rescheduledFrom: old._id,
                sheetSyncStatus: 'pending',
              },
            ],
            { session },
          );



          await Appointment.updateOne({ _id: old._id }, { $set: { status: 'rescheduled' } }).session(session);
          previous = old;




          if (old.pendingReschedule?.newDate && old.pendingReschedule?.newTime) {
            await Appointment.updateOne({ _id: old._id }, { $unset: { pendingReschedule: 1 } }).session(session);
            previous.pendingReschedule = old.pendingReschedule;
          }

          await syncPatientHistory({
            patientId: old.patientId,
            entries: [
              { appointmentId: old._id, date: old.date, time: old.time, status: 'rescheduled' },
              { appointmentId: appointment._id, date: newDate, time: newTime, status: 'confirmed' },
            ],
            session,
          });




          await logAuditMany(
            [
              {
                entity: 'appointment',
                entityId: old._id,
                action: 'rescheduled',
                actor,
                before: { tokenNo: old.tokenNo, date: old.date, time: old.time, status: 'confirmed' },
                after: { tokenNo: old.tokenNo, date: old.date, time: old.time, status: 'rescheduled' },
              },
              {
                entity: 'appointment',
                entityId: appointment._id,
                action: 'rescheduled',
                actor,
                before: { tokenNo, date: newDate, time: newTime, status: 'confirmed', rescheduledFrom: null },
                after: {
                  tokenNo,
                  date: newDate,
                  time: newTime,
                  status: 'confirmed',
                  rescheduledFrom: old._id,
                  slotStart: appointment.slotStart.toISOString(),
                },
              },
            ],
            { session, ordered: true },
          );
        });
        return { appointment, previous };
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          logger.warn('Reschedule rejected by unique index safety net', {
            appointmentId,
            newDate,
            newTime,
            err: err.message,
          });
          throw new SlotTakenError(newDate, newTime, err);
        }
        throw err;
      } finally {
        await session.endSession();
      }
    },
  );



  const {
    enqueueSheetSync = noopEnqueueSheetSync,
    enqueueNotifyDoctor = noopEnqueueNotifyDoctor,
    enqueueScheduleReminders = noopEnqueueScheduleReminders,
    removeReminderJobs = noopRemoveReminderJobs,
    correlationId,
  } = deps;


  if (previous.pendingReschedule?.newDate && previous.pendingReschedule?.newTime) {
    await redis.del(pendingRescheduleKey(previous.doctorId, previous.pendingReschedule.newDate, previous.pendingReschedule.newTime));
  }
  await enqueueSheetSyncAfterCommit(appointment, enqueueSheetSync, correlationId);
  await enqueueSheetSyncAfterCommit(previous, enqueueSheetSync, correlationId);
  await enqueueAfterCommit(
    () => enqueueNotifyDoctor({ appointmentId: previous._id, event: 'rescheduled', correlationId }),
    { op: 'notify-doctor:rescheduled', appointmentId: String(previous._id) },
  );
  await enqueueAfterCommit(
    () => removeReminderJobs({ appointmentId: previous._id, jobIds: previous.reminderJobIds, correlationId }),
    { op: 'remove-reminders:old', appointmentId: String(previous._id) },
  );
  await enqueueAfterCommit(() => enqueueScheduleReminders({ appointmentId: appointment._id, correlationId }), {
    op: 'schedule-reminders',
    appointmentId: String(appointment._id),
  });
  return { appointment, previous };
}

export async function cancelAppointment({ appointmentId, actor = 'patient' }, deps = {}) {
  if (!appointmentId) throw new ValidationError('appointmentId is required to cancel');

  const existing = await Appointment.findById(appointmentId).lean();
  if (!existing) throw new AppointmentNotFoundError(appointmentId);

  const lockKey = slotLockKey(existing.doctorId, existing.date, existing.time);
  const appointment = await withLock(lockKey, BOOKING_LOCK_TTL_MS, async () => {
    const session = await mongoose.startSession();
    try {
      let appointment;
      await session.withTransaction(async () => {
        const current = await Appointment.findById(appointmentId).session(session);
        if (!current) throw new AppointmentNotFoundError(appointmentId);


        if (current.status === 'cancelled') {
          appointment = current;
          return;
        }
        if (current.status !== 'confirmed') {
          throw new AppointmentNotActiveError(appointmentId, current.status);
        }

        await Appointment.updateOne({ _id: current._id }, { $set: { status: 'cancelled' } }).session(session);
        current.status = 'cancelled';



        if (current.pendingReschedule?.newDate && current.pendingReschedule?.newTime) {
          await Appointment.updateOne({ _id: current._id }, { $unset: { pendingReschedule: 1 } }).session(session);
        }

        await syncPatientHistory({
          patientId: current.patientId,
          entries: [
            { appointmentId: current._id, date: current.date, time: current.time, status: 'cancelled' },
          ],
          session,
        });

        await logAudit(
          {
            entity: 'appointment',
            entityId: current._id,
            action: 'cancelled',
            actor,
            before: { tokenNo: current.tokenNo, date: current.date, time: current.time, status: 'confirmed' },
            after: { tokenNo: current.tokenNo, date: current.date, time: current.time, status: 'cancelled' },
          },
          { session },
        );

        appointment = current;
      });
      return appointment;
    } finally {
      await session.endSession();
    }
  });



  const {
    enqueueSheetSync = noopEnqueueSheetSync,
    enqueueNotifyDoctor = noopEnqueueNotifyDoctor,
    removeReminderJobs = noopRemoveReminderJobs,
    correlationId,
  } = deps;


  if (appointment.pendingReschedule?.newDate && appointment.pendingReschedule?.newTime) {
    await redis.del(pendingRescheduleKey(appointment.doctorId, appointment.pendingReschedule.newDate, appointment.pendingReschedule.newTime));
  }
  await enqueueSheetSyncAfterCommit(appointment, enqueueSheetSync, correlationId);
  await enqueueAfterCommit(
    () => enqueueNotifyDoctor({ appointmentId: appointment._id, event: 'cancelled', correlationId }),
    { op: 'notify-doctor:cancelled', appointmentId: String(appointment._id) },
  );
  await enqueueAfterCommit(
    () => removeReminderJobs({ appointmentId: appointment._id, jobIds: appointment.reminderJobIds, correlationId }),
    { op: 'remove-reminders:cancelled', appointmentId: String(appointment._id) },
  );
  return appointment;
}
