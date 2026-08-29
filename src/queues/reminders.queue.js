import { Queue, Worker } from 'bullmq';
import { env } from '../config/env.js';
import { Appointment } from '../models/Appointment.model.js';
import { DoctorConfig } from '../models/DoctorConfig.model.js';
import { MessageLog } from '../models/MessageLog.model.js';
import { sendTextMessage } from '../services/whatsapp.service.js';
import { patientReminder } from '../prompts/templates.js';
import { getConversationLanguage } from '../services/localization.service.js';
import { logger } from '../utils/logger.js';
import { bullmqConnection } from './queue.factory.js';









export const REMINDER_MAX_ATTEMPTS = 3;


let remindersQueue = null;
let remindersDeadQueue = null;

export function getRemindersQueue() {
  if (!remindersQueue) {
    remindersQueue = new Queue(env.remindersQueueName, { connection: bullmqConnection() });
  }
  return remindersQueue;
}

export function getRemindersDeadQueue() {
  if (!remindersDeadQueue) {
    remindersDeadQueue = new Queue(`${env.remindersQueueName}-dead`, { connection: bullmqConnection() });
  }
  return remindersDeadQueue;
}

export async function closeRemindersQueues() {
  if (remindersDeadQueue) {
    await remindersDeadQueue.close();
    remindersDeadQueue = null;
  }
  if (remindersQueue) {
    await remindersQueue.close();
    remindersQueue = null;
  }
}



function reminderJobId(appointmentId, index) {
  return `reminder:${appointmentId}:${index}`;
}

function scheduleReminderJobId(appointmentId) {
  return `schedule:reminder:${appointmentId}`;
}

export function reminderDelayMs({ slotStart, offsetHours, now = Date.now() }) {
  const fireAt = new Date(slotStart).getTime() - offsetHours * 3_600_000;
  if (fireAt <= now) return null;
  return fireAt - now;
}

export async function scheduleAppointmentReminders({ appointment, config, queue = getRemindersQueue(), backoff, correlationId } = {}) {
  const offsets = Array.isArray(config?.reminderOffsetsHours) ? config.reminderOffsetsHours : [];
  const jobIds = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const delay = reminderDelayMs({ slotStart: appointment.slotStart, offsetHours: offsets[i] });
    if (delay == null) continue;
    const jobId = reminderJobId(appointment._id, i);
    const job = await queue.add(
      'reminder',
      { appointmentId: String(appointment._id), offsetHours: offsets[i], correlationId },
      {
        jobId,
        delay,
        attempts: REMINDER_MAX_ATTEMPTS,
        backoff: backoff || { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
    jobIds.push(job.id);
  }
  if (jobIds.length > 0) {
    await Appointment.updateOne({ _id: appointment._id }, { $set: { reminderJobIds: jobIds } });
  }
  return jobIds;
}

export async function enqueueScheduleReminders({ appointmentId, correlationId, attempts = REMINDER_MAX_ATTEMPTS, backoff } = {}) {
  if (!appointmentId) return null;
  const jobId = scheduleReminderJobId(appointmentId);
  const existing = await getRemindersQueue().getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (!['active', 'waiting', 'delayed', 'paused', 'prioritized'].includes(state)) {
      await existing.remove();
    }
  }
  const job = await getRemindersQueue().add(
    'schedule-reminders',
    { appointmentId: String(appointmentId), correlationId },
    {
      jobId,
      attempts,
      backoff: backoff || { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );
  logger.debug('Reminder scheduling job enqueued', { appointmentId: String(appointmentId), jobId: job.id, correlationId });
  return job;
}

export async function removeReminderJobs({ appointmentId, jobIds = [], queue = getRemindersQueue(), correlationId } = {}) {
  const ids = [...new Set((jobIds || []).filter(Boolean))];
  let removed = 0;
  for (const id of ids) {
    try {
      const job = await queue.getJob(id);
      if (job) {
        await job.remove();
        removed += 1;
      }
    } catch (err) {
      logger.warn('Could not remove reminder job', { appointmentId, jobId: id, correlationId, err: { message: err.message } });
    }
  }
  if (ids.length > 0) {
    await Appointment.updateOne({ _id: appointmentId }, { $set: { reminderJobIds: [] } }).catch(() => {});
  }
  logger.debug('Reminder jobs removed', { appointmentId, requested: ids.length, removed, correlationId });
  return { removed };
}


export async function processScheduleRemindersJob(job, deps = {}) {
  const {
    schedule = scheduleAppointmentReminders,
    loadConfig = (doctorId) => DoctorConfig.findById(doctorId).lean(),
  } = deps;
  const { appointmentId, correlationId } = job.data;
  const log = correlationId ? logger.child({ correlationId }) : logger;

  const appointment = await Appointment.findById(appointmentId).lean();
  if (!appointment) {
    log.warn('Reminder schedule job skipped: appointment no longer exists', { appointmentId, jobId: job.id });
    return { skipped: true, reason: 'appointment_missing', appointmentId };
  }
  if (appointment.status !== 'confirmed') {
    log.debug('Reminder schedule job skipped: appointment not confirmed', { appointmentId });
    return { skipped: true, reason: 'not_confirmed', appointmentId };
  }

  const config = await loadConfig(appointment.doctorId);
  if (!config) {
    log.warn('Reminder schedule job skipped: no DoctorConfig for appointment', { appointmentId });
    return { skipped: true, reason: 'doctor_config_missing', appointmentId };
  }

  const jobIds = await schedule({ appointment, config, correlationId });
  return { ok: true, appointmentId, jobIds };
}


export async function processReminderJob(job, deps = {}) {
  const { send = sendTextMessage } = deps;
  const { appointmentId, correlationId } = job.data;
  const log = correlationId ? logger.child({ correlationId }) : logger;

  const appointment = await Appointment.findById(appointmentId).lean();
  if (!appointment) {
    log.warn('Reminder job skipped: appointment no longer exists', { appointmentId, jobId: job.id });
    return { skipped: true, reason: 'appointment_missing', appointmentId };
  }


  if (appointment.status !== 'confirmed') {
    log.debug('Reminder job skipped: appointment not confirmed anymore', {
      appointmentId,
      status: appointment.status,
    });
    return { skipped: true, reason: 'not_confirmed', appointmentId, status: appointment.status };
  }

  const text = patientReminder(
    {
      tokenNo: appointment.tokenNo,
      date: appointment.date,
      time: appointment.time,
    },
    await getConversationLanguage(appointment.patientPhone),
  );

  const messageId = await send({ to: appointment.patientPhone, text });
  await MessageLog.create({
    phone: appointment.patientPhone,
    direction: 'out',
    channel: 'whatsapp',
    body: text,
    waMessageId: messageId || undefined,
  });
  return { ok: true, appointmentId, messageId };
}


export async function moveToDeadLetter(job, err) {
  try {
    const dlqJob = await getRemindersDeadQueue().add(
      'reminders-dead',
      { appointmentId: job.data.appointmentId, jobName: job.name, originalJobId: job.id, correlationId: job.data.correlationId, error: err?.message },
      {
        jobId: `reminders:dead:${job.name}_${job.data.appointmentId}`,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    logger.warn('Reminders job moved to dead-letter queue', { jobId: job.id, dlqJobId: dlqJob.id });
    return dlqJob;
  } catch (dlqErr) {
    logger.error('Could not move reminders job to dead-letter queue', {
      jobId: job.id,
      err: { message: dlqErr.message },
    });
    return null;
  }
}


export function createRemindersWorker(deps = {}) {
  const worker = new Worker(
    env.remindersQueueName,
    (job) => (job.name === 'schedule-reminders' ? processScheduleRemindersJob(job, deps) : processReminderJob(job, deps)),
    { connection: bullmqConnection(), concurrency: 5 },
  );
  worker.on('failed', (job, err) => {
    const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? REMINDER_MAX_ATTEMPTS);
    logger.error('Reminders job failed', {
      jobId: job?.id,
      jobName: job?.name,
      appointmentId: job?.data?.appointmentId,
      correlationId: job?.data?.correlationId,
      attemptsMade: job?.attemptsMade,
      exhausted,
      err: { message: err.message },
    });
    if (exhausted) moveToDeadLetter(job, err);
  });
  return worker;
}
