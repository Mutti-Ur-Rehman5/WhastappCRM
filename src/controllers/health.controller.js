import mongoose from 'mongoose';
import { redis } from '../config/redis.js';
import { getInboundQueue } from '../queues/inboundMessage.queue.js';
import { getSheetsQueue } from '../queues/sheetsSync.queue.js';
import { getNotifyDoctorQueue } from '../queues/notifyDoctor.queue.js';
import { getNotifyPatientQueue } from '../queues/notifyPatient.queue.js';
import { getRemindersQueue } from '../queues/reminders.queue.js';
import { logger } from '../utils/logger.js';





const CHECK_TIMEOUT_MS = 2500;

export const QUEUE_GETTERS = {
  inbound: getInboundQueue,
  sheets: getSheetsQueue,
  notifyDoctor: getNotifyDoctorQueue,
  notifyPatient: getNotifyPatientQueue,
  reminders: getRemindersQueue,
};




function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

export async function mongoCheck() {
  if (mongoose.connection.readyState !== 1) {
    return { ok: false, detail: { state: 'not_connected', readyState: mongoose.connection.readyState } };
  }
  try {
    await withTimeout(mongoose.connection.db.admin().command({ ping: 1 }), CHECK_TIMEOUT_MS, 'mongo');
    return { ok: true, detail: { state: 'connected' } };
  } catch (err) {
    return { ok: false, detail: { state: 'ping_failed', error: err.message } };
  }
}

export async function redisCheck() {
  try {
    const pong = await withTimeout(redis.ping(), CHECK_TIMEOUT_MS, 'redis');
    return { ok: pong === 'PONG', detail: { ping: pong } };
  } catch (err) {
    return { ok: false, detail: { ping: 'failed', error: err.message } };
  }
}

export async function queueChecks(queueGetters = QUEUE_GETTERS) {
  const results = {};
  await Promise.all(
    Object.entries(queueGetters).map(async ([name, getQueue]) => {
      try {
        const queue = getQueue();


        const counts = await withTimeout(
          queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
          CHECK_TIMEOUT_MS,
          `queue:${name}`,
        );
        results[name] = {
          ok: true,
          waiting: counts.waiting,
          active: counts.active,
          delayed: counts.delayed,
          failed: counts.failed,
        };
      } catch (err) {
        results[name] = { ok: false, error: err.message };
      }
    }),
  );
  return results;
}

export function buildHealthHandler(deps = {}) {
  const {
    mongo = mongoCheck,
    redisCheckFn = redisCheck,
    queueGetters = QUEUE_GETTERS,
  } = deps;

  return async function health(req, res, next) {
    try {
      const [m, r, queues] = await Promise.all([mongo(), redisCheckFn(), queueChecks(queueGetters)]);
      const ok = m.ok && r.ok && Object.values(queues).every((q) => q.ok);
      const body = {
        status: ok ? 'ok' : 'degraded',
        mongo: m.ok ? 'ok' : 'down',
        redis: r.ok ? 'ok' : 'down',
        queues: Object.fromEntries(Object.entries(queues).map(([name, q]) => [name, q.ok ? 'ok' : 'down'])),
        details: { mongo: m.detail, redis: r.detail, queues },
      };
      res.status(ok ? 200 : 503).json(body);
    } catch (err) {
      logger.error('Health check failed', { err: { message: err.message, stack: err.stack } });
      next(err);
    }
  };
}

export const health = buildHealthHandler();
