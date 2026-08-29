import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Writable } from 'node:stream';
import winston from 'winston';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { app } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { redis } from '../../src/config/redis.js';
import { Appointment } from '../../src/models/Appointment.model.js';
import { AuditLog } from '../../src/models/AuditLog.model.js';
import { Conversation } from '../../src/models/Conversation.model.js';
import { DoctorConfig, WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import { MessageLog } from '../../src/models/MessageLog.model.js';
import { Patient } from '../../src/models/Patient.model.js';
import { logger } from '../../src/utils/logger.js';
import { convKey } from '../../src/services/conversation.memory.service.js';
import { getInboundQueue, closeInboundQueue, processInboundMessage } from '../../src/queues/inboundMessage.queue.js';
import {
  getRemindersQueue,
  closeRemindersQueues,
  enqueueScheduleReminders,
  processScheduleRemindersJob,
} from '../../src/queues/reminders.queue.js';

// Phase 8 correlation-id DoD: the request id set by requestLogger must ride the
// whole chain — webhook HTTP request → inbound job data → orchestrator logs →
// every spawned queue job payload (sheets/notify/reminders) — so one patient
// turn is traceable end-to-end. Mongo + Redis are real; NLU/WhatsApp/queue
// execution are injected recordings.

const MY_CONFIG = 'correlation.test.config';
const RUN_DIGITS = Date.now().toString().slice(-8);
const PHONE = `+9232${RUN_DIGITS}00`;
const CORR_REM = `corr-rem-${RUN_DIGITS}`;

let config;
let server;
let baseUrl;
let outboundSeq = 0;

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

const sign = (body) => `sha256=${crypto.createHmac('sha256', env.whatsapp.appSecret).update(body).digest('hex')}`;

const webhookBody = (from, text, waMessageId) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'test-ba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15551234567', phone_number_id: env.whatsapp.phoneNumberId },
              messages: [{ from, id: waMessageId, timestamp: '1700000000', type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  });

async function postWebhook(text, waMessageId) {
  const body = webhookBody(PHONE, text, waMessageId);
  const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
    body,
  });
  assert.equal(res.status, 200);
  return res.headers.get('x-request-id');
}

// NLU mocked by message content so the turns stay deterministic.
async function mockNlu({ history }) {
  const last = history.at(-1)?.text?.trim() || '';
  if (/^yes/i.test(last)) return { toolCall: { name: 'confirm', input: { value: true } } };
  if (/query|appointments/i.test(last)) return { toolCall: { name: 'query_my_appointments', input: {} } };
  return {
    toolCall: {
      name: 'book_appointment',
      input: { date: '2099-04-06', time: '10:00', name: 'Correlation Test', reason: 'checkup' },
    },
  };
}

async function mockSendMessage() {
  outboundSeq += 1;
  return `wamid.out.${outboundSeq}.${RUN_DIGITS}`;
}

before(async () => {
  await connectTestDb();
  await DoctorConfig.deleteMany({ doctorName: MY_CONFIG });
  config = await DoctorConfig.create({
    doctorName: MY_CONFIG,
    doctorPhone: '+923001239997',
    timezone: 'Asia/Karachi',
    workingHours: WEEKDAYS.map((day) => ({
      day,
      enabled: day !== 'sunday',
      start: '09:00',
      end: '17:00',
      slotMinutes: 15,
      breaks: [{ start: '13:00', end: '14:00' }],
    })),
    holidays: [],
    bufferMinutes: 5,
  });
  await Appointment.deleteMany({ doctorId: config._id });
  await MessageLog.deleteMany({ phone: PHONE });
  await AuditLog.deleteMany({});
  await Conversation.deleteMany({ phone: PHONE });
  await Patient.deleteMany({ phone: PHONE });
  await redis.del(convKey(PHONE));
  await getInboundQueue().obliterate({ force: true }).catch(() => {});

  server = app.listen(0);
  await waitFor(() => server.listening, { label: 'server listening' });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeInboundQueue();
  await closeRemindersQueues();
  await Appointment.deleteMany({ doctorId: config._id });
  await MessageLog.deleteMany({ phone: PHONE });
  await AuditLog.deleteMany({});
  await Conversation.deleteMany({ phone: PHONE });
  await Patient.deleteMany({ phone: PHONE });
  await DoctorConfig.deleteMany({ doctorName: MY_CONFIG });
  await closeTestDb();
  await redis.quit();
});

describe('correlation id propagation (webhook → queue jobs → logs)', () => {
  it('the webhook request id lands in the inbound job data', async () => {
    const wamid = `wamid.corr.${RUN_DIGITS}.1`;
    const xRequestId = await postWebhook('book an appointment', wamid);

    assert.ok(xRequestId, 'response carries an X-Request-Id header');

    const job = await waitFor(() => getInboundQueue().getJob(wamid), { label: 'inbound job enqueued' });
    assert.equal(job.data.correlationId, xRequestId, 'webhook req.id must ride into the job data');
  });

  it('the same correlation id reaches the orchestrator logs and every spawned queue job', async () => {
    // INFO/DEBUG are filtered out by LOG_LEVEL=warn (.env.test), so the log
    // assertion rides on the orchestrator's warn-level 'intent not implemented'
    // line — which carries the correlation id like every other turn log.
    const spawned = [];
    const rec = (name) => async (args) => {
      spawned.push({ name, ...args });
      return null;
    };
    const deps = {
      sendMessage: mockSendMessage,
      nlu: mockNlu,
      doctorConfig: config,
      enqueueSheetSync: rec('sheetSync'),
      enqueueNotifyDoctor: rec('notifyDoctor'),
      enqueueNotifyPatientConfirmation: rec('notifyPatient'),
      enqueueScheduleReminders: rec('scheduleReminders'),
      removeReminderJobs: rec('removeReminders'),
    };

    const captured = [];
    const transport = new winston.transports.Stream({
      stream: new Writable({
        write(chunk, _enc, cb) {
          captured.push(chunk.toString());
          cb();
        },
      }),
    });
    // LOG_LEVEL=warn (.env.test) filters info records by default — lower it so
    // the orchestrator's structured per-turn log line (which carries the
    // correlation id) is captured, then restore in finally.
    const savedLevel = logger.level;
    logger.level = 'info';
    logger.add(transport);
    try {
      // query turn → warn-level log carrying correlation id idQ.
      const wq = `wamid.corr.${RUN_DIGITS}.query`;
      const idQ = await postWebhook('query my appointments', wq);
      await processInboundMessage(await getInboundQueue().getJob(wq), deps);
      assert.ok(
        captured.some((line) => line.includes(idQ)),
        `orchestrator warn log must carry the correlation id ${idQ}`,
      );

      // book turn (all slots collected → AWAITING_CONFIRMATION).
      const wb = `wamid.corr.${RUN_DIGITS}.book`;
      await postWebhook('book an appointment', wb);
      await processInboundMessage(await getInboundQueue().getJob(wb), deps);

      // confirm turn → real booking → post-commit jobs.
      const wy = `wamid.corr.${RUN_DIGITS}.yes`;
      const idYes = await postWebhook('YES', wy);
      await processInboundMessage(await getInboundQueue().getJob(wy), deps);

      assert.ok(
        captured.some((line) => line.includes(idYes)),
        `orchestrator logs must carry the correlation id ${idYes}`,
      );

      // Every spawned job payload carries the SAME correlation id.
      const names = spawned.map((s) => s.name);
      for (const expected of ['sheetSync', 'notifyDoctor', 'notifyPatient', 'scheduleReminders']) {
        assert.ok(names.includes(expected), `expected a spawned ${expected} job`);
      }
      assert.equal(spawned.length, 4);
      for (const s of spawned) {
        assert.equal(s.correlationId, idYes, `${s.name} must receive correlation id ${idYes}`);
      }
    } finally {
      logger.remove(transport);
      logger.level = savedLevel;
    }
  });

  it('the correlation id propagates into the delayed reminder jobs via schedule-reminders', async () => {
    const appointment = await Appointment.create({
      doctorId: config._id,
      tokenNo: 970000 + Number(RUN_DIGITS.slice(-4)),
      patientId: new mongoose.Types.ObjectId(),
      patientName: 'Reminder Corr',
      patientPhone: PHONE,
      date: '2099-04-06',
      time: '11:00',
      slotStart: new Date('2099-04-06T06:00:00Z'),
      reason: 'checkup',
      status: 'confirmed',
    });

    const schedJob = await enqueueScheduleReminders({ appointmentId: appointment._id, correlationId: CORR_REM });
    const result = await processScheduleRemindersJob(schedJob, { loadConfig: async () => config });

    assert.ok(Array.isArray(result.jobIds) && result.jobIds.length > 0);
    const reminderJob = await getRemindersQueue().getJob(result.jobIds[0]);
    assert.equal(reminderJob.data.correlationId, CORR_REM, 'delayed reminder job must inherit the correlation id');

    await getRemindersQueue().getJob(schedJob.id).then((j) => j && j.remove());
  });
});
