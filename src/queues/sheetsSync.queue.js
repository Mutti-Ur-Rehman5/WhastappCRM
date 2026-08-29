import { Queue, Worker } from 'bullmq';
import { env } from '../config/env.js';
import { Appointment } from '../models/Appointment.model.js';
import { upsertSheetRow } from '../services/sheets.service.js';
import { logger } from '../utils/logger.js';
import { bullmqConnection } from './queue.factory.js';







export const SHEETS_SYNC_MAX_ATTEMPTS = 5;



let sheetsQueue = null;
let sheetsDeadQueue = null;

export function sheetsQueueName() {
  return env.sheetsQueueName;
}

export function sheetsDeadQueueName() {
  return `${env.sheetsQueueName}-dead`;
}

export function getSheetsQueue() {
  if (!sheetsQueue) {
    sheetsQueue = new Queue(sheetsQueueName(), { connection: bullmqConnection() });
  }
  return sheetsQueue;
}

export function getSheetsDeadQueue() {
  if (!sheetsDeadQueue) {
    sheetsDeadQueue = new Queue(sheetsDeadQueueName(), { connection: bullmqConnection() });
  }
  return sheetsDeadQueue;
}

export async function closeSheetsQueues() {
  if (sheetsDeadQueue) {
    await sheetsDeadQueue.close();
    sheetsDeadQueue = null;
  }
  if (sheetsQueue) {
    await sheetsQueue.close();
    sheetsQueue = null;
  }
}

export async function enqueueSheetSync({ appointmentId, correlationId, attempts = SHEETS_SYNC_MAX_ATTEMPTS, backoff } = {}) {
  if (!appointmentId) return null;
  const jobId = `sheet:sync:${appointmentId}`;





  const existing = await getSheetsQueue().getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (!['active', 'waiting', 'delayed', 'paused', 'prioritized'].includes(state)) {
      await existing.remove();
    }
  }
  const job = await getSheetsQueue().add(
    'sheet-sync',
    { appointmentId: String(appointmentId), correlationId },
    {
      jobId,
      attempts,
      backoff: backoff || { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
  logger.debug('Sheets sync job enqueued', { appointmentId: String(appointmentId), jobId: job.id, correlationId });
  return job;
}

export async function processSheetSyncJob(job, deps = {}) {
  const { upsert = upsertSheetRow } = deps;
  const { appointmentId, correlationId } = job.data;
  const log = correlationId ? logger.child({ correlationId }) : logger;
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) {
    log.warn('Sheets sync job skipped: appointment no longer exists', { appointmentId, jobId: job.id });
    return { skipped: true, appointmentId };
  }
  await upsert(appointment);
  return { ok: true, appointmentId, tokenNo: appointment.tokenNo };
}

export async function moveToDeadLetter(job, err) {
  try {
    const dlqJob = await getSheetsDeadQueue().add(
      'sheet-sync-dead',
      { appointmentId: job.data.appointmentId, originalJobId: job.id, error: err?.message },
      {



        jobId: `sheet:dead:${job.data.appointmentId}`,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    logger.warn('Sheets sync job moved to dead-letter queue', { jobId: job.id, dlqJobId: dlqJob.id });
    return dlqJob;
  } catch (dlqErr) {


    logger.error('Could not move job to dead-letter queue', {
      jobId: job.id,
      err: { message: dlqErr.message },
    });
    return null;
  }
}

export function createSheetsSyncWorker(deps = {}) {
  const worker = new Worker(sheetsQueueName(), (job) => processSheetSyncJob(job, deps), {
    connection: bullmqConnection(),
    concurrency: 5,
  });
  worker.on('failed', (job, err) => {
    const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? SHEETS_SYNC_MAX_ATTEMPTS);
    logger.error('Sheets sync job failed', {
      jobId: job?.id,
      appointmentId: job?.data?.appointmentId,
      attemptsMade: job?.attemptsMade,
      exhausted,
      err: { message: err.message },
    });
    if (exhausted) moveToDeadLetter(job, err);
  });
  return worker;
}
