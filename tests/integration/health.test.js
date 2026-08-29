import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { app } from '../../src/app.js';
import { redis } from '../../src/config/redis.js';
import { health, buildHealthHandler } from '../../src/controllers/health.controller.js';
import { closeInboundQueue } from '../../src/queues/inboundMessage.queue.js';
import { closeSheetsQueues } from '../../src/queues/sheetsSync.queue.js';
import { closeNotifyDoctorQueues } from '../../src/queues/notifyDoctor.queue.js';
import { closeNotifyPatientQueue } from '../../src/queues/notifyPatient.queue.js';
import { closeRemindersQueues } from '../../src/queues/reminders.queue.js';

// Phase 8 /health: 200 only when Mongo + Redis + every BullMQ queue is up;
// 503 naming the failing dependency otherwise. The injected-dep tests make the
// 503 paths deterministic; the last two tests tear down the REAL Mongo/Redis
// connections (the "intentionally disconnected" requirement) and reconnect.

let server;
let baseUrl;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, { timeout = 10000, interval = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await cond();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// Invokes a handler directly with a fake req/res (no HTTP round-trip needed).
function invoke(handler) {
  const res = {
    statusCode: 200,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      this.done?.();
    },
  };
  return new Promise((resolve, reject) => {
    res.done = () => resolve(res);
    handler({ headers: {} }, res, reject);
  });
}

before(async () => {
  await connectTestDb();
  server = app.listen(0);
  await waitFor(() => server.listening, { label: 'server listening' });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  // The health handler lazily opens every BullMQ queue to count jobs — close
  // those connections so the process can exit (otherwise node --test hangs).
  await closeInboundQueue();
  await closeSheetsQueues();
  await closeNotifyDoctorQueues();
  await closeNotifyPatientQueue();
  await closeRemindersQueues();
  await closeTestDb();
  await redis.quit();
});

describe('/health', () => {
  it('returns 200 with mongo, redis and all queues up when everything is healthy', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.mongo, 'ok');
    assert.equal(body.redis, 'ok');
    assert.equal(body.queues.inbound, 'ok');
    assert.equal(body.queues.sheets, 'ok');
    assert.equal(body.queues.notifyDoctor, 'ok');
    assert.equal(body.queues.notifyPatient, 'ok');
    assert.equal(body.queues.reminders, 'ok');
    assert.equal(body.details.mongo.state, 'connected');
    assert.equal(body.details.queues.inbound.ok, true);
    assert.ok(Number.isInteger(body.details.queues.inbound.waiting));
    assert.ok(Number.isInteger(body.details.queues.inbound.active));
  });

  it('returns 503 with mongo named as the failing dependency when mongo is down', async () => {
    const handler = buildHealthHandler({
      mongo: async () => ({ ok: false, detail: { state: 'not_connected', readyState: 0 } }),
    });
    const res = await invoke(handler);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, 'degraded');
    assert.equal(res.body.mongo, 'down');
    assert.equal(res.body.redis, 'ok');
    assert.equal(res.body.queues.inbound, 'ok');
  });

  it('returns 503 with redis named as the failing dependency when redis is down', async () => {
    const handler = buildHealthHandler({
      redisCheckFn: async () => ({ ok: false, detail: { ping: null } }),
    });
    const res = await invoke(handler);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.redis, 'down');
    assert.equal(res.body.mongo, 'ok');
  });

  it('returns 503 with the failing queue named when a queue is down', async () => {
    const handler = buildHealthHandler({
      queueGetters: { sheets: () => ({ getJobCounts: () => Promise.reject(new Error('redis offline')) }) },
    });
    const res = await invoke(handler);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.mongo, 'ok');
    assert.equal(res.body.redis, 'ok');
    assert.equal(res.body.queues.sheets, 'down');
  });

  it('returns 503 when Mongo is really disconnected, then 200 again after reconnect', async () => {
    await mongoose.disconnect();
    try {
      const res = await invoke(health);
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.mongo, 'down');
      assert.equal(res.body.redis, 'ok');
    } finally {
      await connectTestDb();
    }

    const recovered = await invoke(health);
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.body.mongo, 'ok');
  });

  it('returns 503 when Redis is really disconnected, then 200 again after reconnect', async () => {
    redis.disconnect();
    try {
      const res = await invoke(health);
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.redis, 'down');
      assert.equal(res.body.mongo, 'ok');
    } finally {
      await redis.connect();
    }

    const recovered = await invoke(health);
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.body.redis, 'ok');
  });
});
