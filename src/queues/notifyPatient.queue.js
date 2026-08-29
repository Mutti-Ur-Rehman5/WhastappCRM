import { Queue, Worker } from 'bullmq';
import { env } from '../config/env.js';
import { Appointment } from '../models/Appointment.model.js';
import { DoctorConfig } from '../models/DoctorConfig.model.js';
import { MessageLog } from '../models/MessageLog.model.js';
import { sendPatientMessage } from '../services/whatsapp.service.js';
import { patientConfirmation } from '../prompts/templates.js';
import { getConversationLanguage, postBookButtons } from '../services/localization.service.js';
import { logger } from '../utils/logger.js';
import { bullmqConnection } from './queue.factory.js';








export const NOTIFY_PATIENT_MAX_ATTEMPTS = 3;






export const PATIENT_CONFIRM_DELAY_MS = 60_000;


let notifyPatientQueue = null;

export function getNotifyPatientQueue() {
  if (!notifyPatientQueue) {
    notifyPatientQueue = new Queue(env.notifyPatientQueueName, { connection: bullmqConnection() });
  }
  return notifyPatientQueue;
}

export async function closeNotifyPatientQueue() {
  if (notifyPatientQueue) {
    await notifyPatientQueue.close();
    notifyPatientQueue = null;
  }
}

export async function enqueueNotifyPatientConfirmation({
  appointmentId,
  correlationId,
  delay = PATIENT_CONFIRM_DELAY_MS,
  attempts = NOTIFY_PATIENT_MAX_ATTEMPTS,
  backoff,
} = {}) {
  if (!appointmentId) return null;
  const jobId = `notify:patient:confirm_${appointmentId}`;
  const job = await getNotifyPatientQueue().add(
    'notify-patient-confirmation',
    { appointmentId: String(appointmentId), correlationId },
    {
      jobId,
      delay,
      attempts,
      backoff: backoff || { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
  logger.debug('Patient confirmation job enqueued', { appointmentId: String(appointmentId), jobId: job.id, delay, correlationId });
  return job;
}

export async function processNotifyPatientConfirmationJob(job, deps = {}) {
  const {
    send = sendPatientMessage,
    loadConfig = (doctorId) => DoctorConfig.findById(doctorId).lean(),
  } = deps;
  const { appointmentId, correlationId } = job.data;
  const log = correlationId ? logger.child({ correlationId }) : logger;

  const appointment = await Appointment.findById(appointmentId).lean();
  if (!appointment) {
    log.warn('Patient confirmation job skipped: appointment no longer exists', { appointmentId, jobId: job.id });
    return { skipped: true, reason: 'appointment_missing', appointmentId };
  }
  if (appointment.status !== 'confirmed') {
    log.debug('Patient confirmation job skipped: appointment not confirmed', {
      appointmentId,
      status: appointment.status,
    });
    return { skipped: true, reason: 'not_confirmed', appointmentId, status: appointment.status };
  }

  const config = await loadConfig(appointment.doctorId);
  const lang = await getConversationLanguage(appointment.patientPhone);
  const text = patientConfirmation(
    {
      tokenNo: appointment.tokenNo,
      date: appointment.date,
      time: appointment.time,
      doctorName: config?.doctorName,
      reason: appointment.reason,
    },
    lang,
  );

  const alreadyDelivered = await MessageLog.exists({
    direction: 'out',
    channel: 'whatsapp',
    phone: appointment.patientPhone,
    body: text,
  });
  if (alreadyDelivered) {
    log.debug('Patient confirmation job skipped: already delivered by the chat reply', { appointmentId });
    return { skipped: true, reason: 'already_delivered', appointmentId };
  }

  const messageId = await send({ to: appointment.patientPhone, text, buttons: postBookButtons(lang) });
  await MessageLog.create({
    phone: appointment.patientPhone,
    direction: 'out',
    channel: 'whatsapp',
    body: text,
    waMessageId: messageId || undefined,
  });
  return { ok: true, appointmentId, messageId };
}

export function createNotifyPatientWorker(deps = {}) {
  const worker = new Worker(
    env.notifyPatientQueueName,
    (job) => processNotifyPatientConfirmationJob(job, deps),
    { connection: bullmqConnection(), concurrency: 5 },
  );
  worker.on('failed', (job, err) => {
    const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? NOTIFY_PATIENT_MAX_ATTEMPTS);
    logger.error('Patient confirmation job failed', {
      jobId: job?.id,
      appointmentId: job?.data?.appointmentId,
      correlationId: job?.data?.correlationId,
      attemptsMade: job?.attemptsMade,
      exhausted,
      err: { message: err.message },
    });
  });
  return worker;
}
