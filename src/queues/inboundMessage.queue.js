import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { redis } from '../config/redis.js';
import { MessageLog } from '../models/MessageLog.model.js';
import { handleInbound } from '../orchestrator/conversation.orchestrator.js';
import { sendTextMessage } from '../services/whatsapp.service.js';
import { logger } from '../utils/logger.js';
import { bullmqConnection } from './queue.factory.js';









const INBOUND_FIFO_PREFIX = 'inbound:fifo:';
const INBOUND_LOCK_PREFIX = 'inbound:lock:';
const INBOUND_LOCK_TTL_MS = 30_000;
const INBOUND_TICKET_TTL_MS = 5_000;
const INBOUND_LOCK_WAIT_MS = 60_000;













const ACQUIRE_FIFO_LOCK_SCRIPT = `
local function evictStaleFront()
  local front = redis.call('lindex', KEYS[1], 0)
  if not front or front == ARGV[1] then return front end
  if not redis.call('get', KEYS[2])
     and redis.call('exists', KEYS[1] .. ':t:' .. front) == 0 then
    redis.call('lpop', KEYS[1])
    return evictStaleFront()
  end
  return front
end

redis.call('set', KEYS[1] .. ':t:' .. ARGV[1], '1', 'PX', ARGV[3])
if not redis.call('lpos', KEYS[1], ARGV[1]) then
  redis.call('rpush', KEYS[1], ARGV[1])
end
local front = evictStaleFront()
if front == ARGV[1] then
  if redis.call('set', KEYS[2], ARGV[1], 'PX', ARGV[2], 'NX') then
    redis.call('lpop', KEYS[1])
    redis.call('del', KEYS[1] .. ':t:' .. ARGV[1])
    return 1
  end
end
return 0
`;



const RELEASE_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireInboundMutex(phone, { ttlMs = INBOUND_LOCK_TTL_MS, waitMs = INBOUND_LOCK_WAIT_MS } = {}) {
  const queueKey = `${INBOUND_FIFO_PREFIX}${phone}`;
  const lockKey = `${INBOUND_LOCK_PREFIX}${phone}`;
  const token = randomUUID();
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    const acquired = await redis.eval(
      ACQUIRE_FIFO_LOCK_SCRIPT,
      2,
      queueKey,
      lockKey,
      token,
      ttlMs,
      INBOUND_TICKET_TTL_MS,
    );
    if (acquired === 1) {
      return { release: () => redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token) };
    }
    await sleep(20);
  }



  await redis.lrem(queueKey, 0, token);
  await redis.del(`${queueKey}:t:${token}`);
  throw new Error(`Timed out waiting for per-phone FIFO lock for ${phone}`);
}


let queueInstance = null;

export function getInboundQueue() {
  if (!queueInstance) {
    queueInstance = new Queue(env.inboundQueueName, { connection: bullmqConnection() });
  }
  return queueInstance;
}

export async function closeInboundQueue() {
  if (queueInstance) {
    await queueInstance.close();
    queueInstance = null;
  }
}

export async function enqueueInboundMessage({ phone, text, audio, waMessageId, correlationId }) {
  const job = await getInboundQueue().add(
    'inbound',
    { phone, text, audio, waMessageId, correlationId },
    {



      jobId: waMessageId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
  logger.info('Inbound message enqueued', { phone, waMessageId, jobId: job.id, correlationId });
  return job;
}

export async function processInboundMessage(job, deps = {}) {
  const { phone, text, audio, waMessageId, correlationId } = job.data;
  const log = correlationId ? logger.child({ correlationId }) : logger;

  log.info('Processing inbound job', {
    jobId: job.id,
    attemptsMade: job.attemptsMade,
    phone,
    waMessageId,
    hasAudio: Boolean(audio),
  });

  const mutex = await acquireInboundMutex(phone);
  try {



    const body = audio ? '[voice note]' : text;
    const inbound = await MessageLog.findOne({ waMessageId, direction: 'in' });
    if (!inbound) {
      try {
        await MessageLog.create({ phone, direction: 'in', channel: 'whatsapp', body, waMessageId });
      } catch (err) {


        if (err?.code !== 11000) throw err;
      }
    }

    return await handleInbound({ phone, text, media: audio, waMessageId }, { ...deps, correlationId });
  } finally {
    await mutex.release();
  }
}

export function createInboundWorker({
  sendMessage = sendTextMessage,
  sendVoiceMessage,
  nlu,
  todayRef,
  doctorConfig,
  enqueueSheetSync,
  enqueueNotifyDoctor,
  enqueueNotifyPatientConfirmation,
  enqueueScheduleReminders,
  removeReminderJobs,
} = {}) {
  const worker = new Worker(
    env.inboundQueueName,
    (job) =>
      processInboundMessage(job, {
        sendMessage,
        sendVoiceMessage,
        nlu,
        todayRef,
        doctorConfig,
        enqueueSheetSync,
        enqueueNotifyDoctor,
        enqueueNotifyPatientConfirmation,
        enqueueScheduleReminders,
        removeReminderJobs,
      }),
    { connection: bullmqConnection(), concurrency: 5 },
  );
  worker.on('failed', (job, err) => {
    logger.error('Inbound job failed', {
      jobId: job?.id,
      phone: job?.data?.phone,
      correlationId: job?.data?.correlationId,
      err: { message: err.message, status: err.response?.status },
    });
  });
  return worker;
}
