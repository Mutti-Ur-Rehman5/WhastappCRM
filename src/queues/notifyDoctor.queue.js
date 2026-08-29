import { Queue, Worker } from 'bullmq';
import { env } from '../config/env.js';
import { Appointment } from '../models/Appointment.model.js';
import { DoctorConfig } from '../models/DoctorConfig.model.js';
import { MessageLog } from '../models/MessageLog.model.js';
import { sendTextMessage } from '../services/whatsapp.service.js';
import { sendDoctorNotificationEmail } from '../services/email.service.js';
import { doctorNotification, NOTIFY_EVENT_LABELS } from '../prompts/templates.js';
import { logger } from '../utils/logger.js';
import { bullmqConnection } from './queue.factory.js';






export const NOTIFY_DOCTOR_MAX_ATTEMPTS = 3;


let notifyDoctorQueue = null;
let notifyDoctorDeadQueue = null;

export function getNotifyDoctorQueue() {
  if (!notifyDoctorQueue) {
    notifyDoctorQueue = new Queue(env.notifyDoctorQueueName, { connection: bullmqConnection() });
  }
  return notifyDoctorQueue;
}

export function getNotifyDoctorDeadQueue() {
  if (!notifyDoctorDeadQueue) {
    notifyDoctorDeadQueue = new Queue(`${env.notifyDoctorQueueName}-dead`, { connection: bullmqConnection() });
  }
  return notifyDoctorDeadQueue;
}

export async function closeNotifyDoctorQueues() {
  if (notifyDoctorDeadQueue) {
    await notifyDoctorDeadQueue.close();
    notifyDoctorDeadQueue = null;
  }
  if (notifyDoctorQueue) {
    await notifyDoctorQueue.close();
    notifyDoctorQueue = null;
  }
}

export async function enqueueNotifyDoctor({ appointmentId, event, correlationId, attempts = NOTIFY_DOCTOR_MAX_ATTEMPTS, backoff } = {}) {
  if (!appointmentId || !event) return null;
  const jobId = `notify:doctor:${event}_${appointmentId}`;
  const job = await getNotifyDoctorQueue().add(
    'notify-doctor',
    { appointmentId: String(appointmentId), event, correlationId },
    {
      jobId,
      attempts,
      backoff: backoff || { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
  logger.debug('Doctor notify job enqueued', { appointmentId: String(appointmentId), event, jobId: job.id, correlationId });
  return job;
}

function notificationSubject(event, tokenNo) {
  return `Clinic: ${NOTIFY_EVENT_LABELS[event] || event} — Token #${tokenNo}`;
}

export async function processNotifyDoctorJob(job, deps = {}) {
  const {
    send = sendTextMessage,
    sendEmail = sendDoctorNotificationEmail,
    loadConfig = (doctorId) => DoctorConfig.findById(doctorId).lean(),
  } = deps;
  const { appointmentId, event, correlationId } = job.data;
  const log = correlationId ? logger.child({ correlationId }) : logger;

  const appointment = await Appointment.findById(appointmentId).lean();
  if (!appointment) {
    log.warn('Doctor notify job skipped: appointment no longer exists', { appointmentId, event, jobId: job.id });
    return { skipped: true, reason: 'appointment_missing', appointmentId };
  }

  const config = await loadConfig(appointment.doctorId);
  if (!config) {
    log.warn('Doctor notify job skipped: no DoctorConfig for appointment', { appointmentId, event });
    return { skipped: true, reason: 'doctor_config_missing', appointmentId };
  }

  if (Array.isArray(config.notifyDoctorOn) && !config.notifyDoctorOn.includes(event)) {
    log.debug('Doctor notify job skipped: event not in notifyDoctorOn', { appointmentId, event });
    return { skipped: true, reason: 'event_not_enabled', event, appointmentId };
  }

  const text = doctorNotification({
    event,
    tokenNo: appointment.tokenNo,
    patientName: appointment.patientName,
    patientPhone: appointment.patientPhone,
    date: appointment.date,
    time: appointment.time,
    reason: appointment.reason,
  });



  let whatsappOk = false;
  let whatsappMessageId = null;
  try {
    const messageId = await send({ to: config.doctorPhone, text });
    await MessageLog.create({
      phone: config.doctorPhone,
      direction: 'out',
      channel: 'whatsapp',
      body: text,
      waMessageId: messageId || undefined,
    });
    whatsappOk = true;
    whatsappMessageId = messageId;
  } catch (whatsappErr) {
    log.warn('Doctor WhatsApp notification failed — email still being sent', {
      appointmentId,
      event,
      doctorPhone: config.doctorPhone,
      err: { message: whatsappErr.message },
    });
  }


  let emailOk = false;
  let emailMessageId = null;
  let emailErr = null;
  try {
    const info = await sendEmail({
      to: env.doctorEmail,
      subject: notificationSubject(event, appointment.tokenNo),
      text,
    });
    await MessageLog.create({
      phone: config.doctorPhone,
      direction: 'out',
      channel: 'email',
      body: text,
    });
    emailOk = true;
    emailMessageId = info?.messageId ?? null;
  } catch (err) {
    emailErr = err;
    log.error('Doctor email notification failed', {
      appointmentId,
      event,
      email: err.message,
    });
  }

  if (!whatsappOk && !emailOk) {
    log.error('Doctor notify exhausted WhatsApp AND email', {
      appointmentId,
      event,
      whatsapp: 'failed',
      email: emailErr?.message,
    });
    throw emailErr || new Error('Both WhatsApp and email notification channels failed');
  }

  return {
    ok: true,
    event,
    appointmentId,
    channel: whatsappOk ? 'whatsapp' : 'email',
    messageId: whatsappOk ? whatsappMessageId : emailMessageId,
    emailSent: emailOk,
    whatsappOk,
  };
}

export async function moveToDeadLetter(job, err) {
  try {
    const dlqJob = await getNotifyDoctorDeadQueue().add(
      'notify-doctor-dead',
      {
        appointmentId: job.data.appointmentId,
        event: job.data.event,
        correlationId: job.data.correlationId,
        originalJobId: job.id,
        error: err?.message,
      },
      {
        jobId: `notify:dead:${job.data.event}_${job.data.appointmentId}`,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    logger.warn('Doctor notify job moved to dead-letter queue', { jobId: job.id, dlqJobId: dlqJob.id });
    return dlqJob;
  } catch (dlqErr) {
    logger.error('Could not move doctor-notify job to dead-letter queue', {
      jobId: job.id,
      err: { message: dlqErr.message },
    });
    return null;
  }
}

export function createNotifyDoctorWorker(deps = {}) {
  const worker = new Worker(env.notifyDoctorQueueName, (job) => processNotifyDoctorJob(job, deps), {
    connection: bullmqConnection(),
    concurrency: 5,
  });
  worker.on('failed', (job, err) => {
    const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? NOTIFY_DOCTOR_MAX_ATTEMPTS);
    logger.error('Doctor notify job failed', {
      jobId: job?.id,
      appointmentId: job?.data?.appointmentId,
      event: job?.data?.event,
      attemptsMade: job?.attemptsMade,
      exhausted,
      err: { message: err.message },
    });
    if (exhausted) moveToDeadLetter(job, err);
  });
  return worker;
}
