import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Redlock from 'redlock';
import { connectTestDb, closeTestDb } from '../../helpers/db.js';
import { redis } from '../../../src/config/redis.js';
import { Appointment } from '../../../src/models/Appointment.model.js';
import { Patient } from '../../../src/models/Patient.model.js';
import { DoctorConfig } from '../../../src/models/DoctorConfig.model.js';
import { MessageLog } from '../../../src/models/MessageLog.model.js';
import { Conversation } from '../../../src/models/Conversation.model.js';
import { bookAppointment } from '../../../src/services/booking.service.js';
import { handleInbound, LOCK_BUSY_REPLY } from '../../../src/orchestrator/conversation.orchestrator.js';
import { LockUnavailableError } from '../../../src/utils/errors.js';
import { makeDoctorConfig } from '../load/helpers.js';
import { invalidateDoctorConfigCache } from '../../../src/services/slot.service.js';

// DESIGN.md §10: "Redis lock unavailable → fail closed". A rogue process holds
// the slot lock (simulating a stuck holder / degraded Redis) and the system must
// refuse to book, tell the patient "busy, try again in a moment", keep the
// conversation state so they can retry, and recover the moment the lock frees.

const PHONE = '+923099123002';
const DATE = '2099-08-03';
const TIME = '09:30';

function slotLockKey(doctorId, date, time) {
  return `lock:slot:${doctorId}:${date}:${time}`;
}

function scriptedNlu(toolCall) {
  return async () => ({ toolCall });
}

async function runTurn(phone, text, waMessageId, toolCall) {
  return handleInbound(
    { phone, text, waMessageId },
    {
      nlu: scriptedNlu(toolCall),
      sendMessage: async () => `out-${waMessageId}`,
      todayRef: '2099-08-01',
      doctorConfig: config,
    },
  );
}

let config;
let patient;
let rogueLock;

before(async () => {
  await connectTestDb();
  await DoctorConfig.deleteMany({ doctorName: 'redis-lock-chaos.config' });
  config = await makeDoctorConfig({ doctorName: 'redis-lock-chaos.config', doctorPhone: '+923001239982' });
  await invalidateDoctorConfigCache();
  await Appointment.deleteMany({ doctorId: config._id });
  await Conversation.deleteMany({ phone: PHONE });
  await MessageLog.deleteMany({ phone: PHONE });
  patient = await Patient.create({ name: 'Chaos Patient', phone: PHONE });
});

after(async () => {
  await rogueLock?.release().catch(() => {});
  await Conversation.deleteMany({ phone: PHONE });
  await MessageLog.deleteMany({ phone: PHONE });
  await Appointment.deleteMany({ doctorId: config._id });
  await Patient.deleteMany({ phone: PHONE });
  await DoctorConfig.deleteMany({ doctorName: 'redis-lock-chaos.config' });
  await closeTestDb();
  await redis.quit();
});

describe('chaos: Redis slot lock stuck → fail closed (DESIGN.md §10)', () => {
  it('bookAppointment fails closed with LockUnavailableError and creates nothing', async () => {
    const rogue = new Redlock([redis], { retryCount: 0 });
    rogueLock = await rogue.acquire([slotLockKey(config._id, DATE, TIME)], 60_000);

    await assert.rejects(
      bookAppointment({ doctorId: config._id, date: DATE, time: TIME, patient, reason: 'chaos' }),
      (err) => err instanceof LockUnavailableError,
    );

    const inDb = await Appointment.countDocuments({ doctorId: config._id, date: DATE, time: TIME });
    assert.equal(inDb, 0, 'a failed-closed booking must not create an appointment');
  });

  it('the chat flow surfaces a friendly "busy" reply and recovers once the lock frees', async () => {
    await runTurn(PHONE, 'book this slot', 'lock-chaos-turn-1', {
      name: 'book_appointment',
      input: { date: DATE, time: TIME },
    });
    await runTurn(PHONE, 'my name is Chaos Patient', 'lock-chaos-turn-2', {
      name: 'book_appointment',
      input: { name: 'Chaos Patient', phone: PHONE, reason: 'chaos' },
    });

    // The rogue lock is STILL held → confirm fails closed with a friendly reply.
    const busy = await runTurn(PHONE, 'YES', 'lock-chaos-turn-3', { name: 'confirm', input: { value: true } });
    assert.equal(busy.reply, LOCK_BUSY_REPLY);
    assert.equal(busy.state, 'AWAITING_CONFIRMATION', 'the conversation must stay bookable so the patient can retry');

    const stillNone = await Appointment.countDocuments({ doctorId: config._id, date: DATE, time: TIME });
    assert.equal(stillNone, 0);

    // The stuck lock frees; the SAME conversation retries and books.
    await rogueLock.release();
    rogueLock = null;

    const retry = await runTurn(PHONE, 'YES', 'lock-chaos-turn-4', { name: 'confirm', input: { value: true } });
    assert.notEqual(retry.reply, LOCK_BUSY_REPLY);
    assert.match(retry.reply, /Token #\d+/);
    assert.equal(retry.state, 'IDLE');

    const inDb = await Appointment.countDocuments({ doctorId: config._id, date: DATE, time: TIME });
    assert.equal(inDb, 1, 'after the lock frees the booking succeeds');
  });
});
