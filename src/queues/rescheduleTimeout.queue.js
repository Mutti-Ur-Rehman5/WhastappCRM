import { Queue, Worker } from 'bullmq';
import { env } from '../config/env.js';
import { expireReschedule } from '../services/rescheduleConfirmation.service.js';
import { logger } from '../utils/logger.js';
import { bullmqConnection } from './queue.factory.js';









let rescheduleTimeoutQueue = null;

export function getRescheduleTimeoutQueue() {
  if (!rescheduleTimeoutQueue) {
    rescheduleTimeoutQueue = new Queue(env.rescheduleTimeoutQueueName, { connection: bullmqConnection() });
  }
  return rescheduleTimeoutQueue;
}

export async function closeRescheduleTimeoutQueue() {
  if (rescheduleTimeoutQueue) {
    await rescheduleTimeoutQueue.close();
    rescheduleTimeoutQueue = null;
  }
}

export async function enqueueRescheduleTimeout({ token, delayMs, correlationId } = {}) {
  if (!token) return null;
  const jobId = `rs-timeout:${token}`;
  const job = await getRescheduleTimeoutQueue().add(
    'reschedule-timeout',
    { token, correlationId },
    {
      jobId,
      delay: Math.max(0, delayMs ?? 0),
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 1000,
    },
  );
  logger.debug('Reschedule timeout job enqueued', { token, delayMs, jobId: job.id, correlationId });
  return job;
}

export async function removeRescheduleTimeoutJob(token) {
  if (!token) return null;
  return getRescheduleTimeoutQueue().remove(`rs-timeout:${token}`);
}

export async function processRescheduleTimeoutJob(job, deps = {}) {
  const {
    expire = expireReschedule,
    reenqueue = enqueueRescheduleTimeout,
  } = deps;
  const { token, correlationId } = job.data;
  const log = correlationId ? logger.child({ correlationId }) : logger;

  const result = await expire(token, { correlationId });
  if (result?.skipped && result.reason === 'not_yet_expired') {
    log.info('Reschedule timeout fired early — rescheduling', { token, remainingMs: result.remainingMs, jobId: job.id });
    await reenqueue({ token, delayMs: result.remainingMs, correlationId });
  }
  return result;
}

export function createRescheduleTimeoutWorker(deps = {}) {
  const worker = new Worker(env.rescheduleTimeoutQueueName, (job) => processRescheduleTimeoutJob(job, deps), {
    connection: bullmqConnection(),
    concurrency: 5,
  });
  worker.on('failed', (job, err) => {
    logger.error('Reschedule timeout job failed', {
      jobId: job?.id,
      token: job?.data?.token,
      attemptsMade: job?.attemptsMade,
      err: { message: err.message },
    });
  });
  return worker;
}
