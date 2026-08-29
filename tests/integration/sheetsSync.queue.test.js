import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { redis } from '../../src/config/redis.js';
import { Appointment } from '../../src/models/Appointment.model.js';
import { DoctorConfig, WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import { Patient } from '../../src/models/Patient.model.js';
import { bookAppointment } from '../../src/services/booking.service.js';
import { upsertSheetRow, rowMapKey } from '../../src/services/sheets.service.js';
import {
  SHEETS_SYNC_MAX_ATTEMPTS,
  enqueueSheetSync,
  createSheetsSyncWorker,
  processSheetSyncJob,
  getSheetsQueue,
  getSheetsDeadQueue,
  closeSheetsQueues,
} from '../../src/queues/sheetsSync.queue.js';
import { invalidateDoctorConfigCache } from '../../src/services/slot.service.js';

// Sheets-sync queue end-to-end against the REAL BullMQ worker + Mongo + Redis,
// with ONLY the googleapis client mocked (RULES.md §7). Proves:
//   - booking enqueues a sync job and the row lands in the Sheet (append/update)
//   - a failed Sheets call marks 'failed', is retried (withRetry count via mock
//     AND job-level retry), then succeeds
//   - after max attempts the job moves to the dead-letter queue and the worker
//     process keeps processing (never crashes)
//   - a Sheets sync failure never blocks or rolls back the appointment

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, { timeout = 15000, interval = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await cond();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const PHONE = '+923004000001';
const retryOptions = { attempts: 3, baseDelayMs: 5, jitterMs: 0 };
const jobBackoff = { type: 'exponential', delay: 50 };

// The DLQ tests exercise BullMQ retry semantics, not the Phase 9 circuit
// breaker — inject a pass-through breaker so the real singleton cannot trip
// open mid-test (the breaker's own behavior is covered in sheets.service and
// the chaos suite).
const noopBreaker = { fire: async ({ call }) => call() };

let doctorConfig;
let worker;

// Mutable fake googleapis Sheets client: failCount = API calls to fail before
// succeeding; failAll = fail everything (for the DLQ test).
const calls = { append: [], update: [] };
let failCount = 0;
let failAll = false;

async function maybeFail() {
  if (failAll) throw new Error('sheets API down');
  if (failCount > 0) {
    failCount -= 1;
    throw new Error('sheets quota exceeded');
  }
}

const fakeSheetsClient = {
  spreadsheets: {
    values: {
      async append(args) {
        calls.append.push(args);
        await maybeFail();
        return { data: { updates: { updatedRange: 'Appointments!A7:H7' } } };
      },
      async update(args) {
        calls.update.push(args);
        await maybeFail();
        return { data: {} };
      },
    },
  },
};

const boundUpsert = (appointment) =>
  upsertSheetRow(appointment, { sheetsClient: fakeSheetsClient, retryOptions, breaker: noopBreaker });

async function book(phone, time, { enqueue } = {}) {
  const patient = await Patient.create({ name: 'Sync Patient', phone });
  return bookAppointment(
    { doctorId: doctorConfig._id, date: '2026-09-01', time, patient, reason: 'checkup' },
    {
      enqueueSheetSync:
        enqueue ??
        (({ appointmentId }) => enqueueSheetSync({ appointmentId, backoff: jobBackoff })),
    },
  );
}

before(async () => {
  await connectTestDb();
  await redis.del(rowMapKey());
  await Patient.deleteMany({ phone: /^\+923004000/ });
  await Appointment.deleteMany({ patientPhone: /^\+923004000/ });
  await DoctorConfig.deleteMany({ doctorName: 'sheets.sync.test.config' });
  await getSheetsQueue().obliterate({ force: true }).catch(() => {});
  await getSheetsDeadQueue().obliterate({ force: true }).catch(() => {});
  doctorConfig = await DoctorConfig.create({
    doctorName: 'sheets.sync.test.config',
    doctorPhone: '+923001239990',
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
  await invalidateDoctorConfigCache();
  worker = createSheetsSyncWorker({ upsert: boundUpsert });
});

after(async () => {
  await worker?.close();
  await getSheetsQueue().obliterate({ force: true }).catch(() => {});
  await getSheetsDeadQueue().obliterate({ force: true }).catch(() => {});
  await closeSheetsQueues();
  await closeTestDb();
  await redis.quit();
});

describe('sheets-sync queue (real worker + Mongo/Redis, mocked googleapis)', () => {
  it('production contract: max 5 attempts with exponential backoff', () => {
    assert.equal(SHEETS_SYNC_MAX_ATTEMPTS, 5);
  });

  it('booking enqueues a sync job and the worker appends the row to the Sheet', async () => {
    failCount = 0;
    failAll = false;
    calls.append.length = 0;

    const appointment = await book(PHONE, '09:00');
    assert.equal(appointment.status, 'confirmed');

    await waitFor(
      async () => (await Appointment.findById(appointment._id).lean())?.sheetSyncStatus === 'synced',
      { label: 'appointment synced' },
    );

    assert.equal(calls.append.length, 1, 'exactly one append for a fresh tokenNo');
    const doc = await Appointment.findById(appointment._id).lean();
    assert.equal(doc.sheetSyncStatus, 'synced');
    assert.equal(doc.sheetRowId, '7');
    const [tokenNo, patientName, patientPhone, date, time, status, updatedAt, notes] =
      calls.append[0].requestBody.values[0];
    assert.equal(tokenNo, doc.tokenNo);
    assert.equal(patientName, 'Sync Patient');
    assert.equal(patientPhone, PHONE);
    assert.equal(date, '2026-09-01');
    assert.equal(time, '09:00');
    assert.equal(status, 'confirmed');
    assert.equal(updatedAt, new Date(doc.updatedAt).toISOString());
    assert.equal(notes, '', 'Notes column mirrors appointment.notes (reason is a separate field, DESIGN §7)');
    assert.equal(calls.append[0].spreadsheetId, 'test-spreadsheet-id');
    assert.equal(calls.append[0].range, 'Appointments!A:H');
  });

  it('consumer is idempotent: re-running syncs the same token in place (update)', async () => {
    failCount = 0;
    failAll = false;
    // Noop the real enqueue: this test drives processSheetSyncJob directly with
    // an injected row-map entry, and the live worker must not race it (it would
    // re-append and clobber the injected sheetRowId).
    const appointment = await book('+923004000002', '09:20', { enqueue: async () => {} });
    // Simulate an existing sheet row for this token (the row map would hold it
    // after a previous append — here injected to prove the update path).
    const fakeJob = {
      id: `sheet:sync:${appointment._id}`,
      data: { appointmentId: String(appointment._id) },
    };
    await processSheetSyncJob(fakeJob, {
      upsert: (appt) =>
        upsertSheetRow(appt, {
          sheetsClient: fakeSheetsClient,
          findRowByToken: async () => 9,
          rememberRow: async () => {},
          retryOptions,
          breaker: noopBreaker,
        }),
    });

    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].range, 'Appointments!A9:H9');
    const doc = await Appointment.findById(appointment._id).lean();
    assert.equal(doc.sheetSyncStatus, 'synced');
    assert.equal(doc.sheetRowId, '9');
  });

  it('consumer no-ops when the appointment no longer exists', async () => {
    const fakeJob = {
      id: 'sheet:sync:missing',
      data: { appointmentId: String(new mongoose.Types.ObjectId()) },
    };
    const result = await processSheetSyncJob(fakeJob, { upsert: boundUpsert });
    assert.deepEqual(result, { skipped: true, appointmentId: fakeJob.data.appointmentId });
  });

  it('failed Sheets call marks failed, job is retried by BullMQ, then succeeds (retry count via mock)', async () => {
    failCount = 3; // each upsert's withRetry (3 attempts) exhausts on job attempt 1
    failAll = false;
    calls.append.length = 0;

    const appointment = await book('+923004000003', '09:40');

    // Wait until the first job attempt has failed (appointment flagged failed).
    await waitFor(
      async () => (await Appointment.findById(appointment._id).lean())?.sheetSyncStatus === 'failed',
      { label: 'first attempt failed' },
    );

    // Now let the API recover so the job's retry succeeds.
    failCount = 0;
    await waitFor(
      async () => (await Appointment.findById(appointment._id).lean())?.sheetSyncStatus === 'synced',
      { label: 'job retried and synced' },
    );

    // BullMQ bumps attemptsMade when the job transitions to completed — AFTER
    // the processor returns — but the appointment is flagged 'synced' inside
    // the processor (attempt 2). Wait for the job to actually finish so the
    // counter is final before reading it (removes the read-too-early race).
    await waitFor(
      async () => {
        const j = await getSheetsQueue().getJob(`sheet:sync:${appointment._id}`);
        return !!j && (await j.getState()) === 'completed' && j.attemptsMade === 2;
      },
      { label: 'job completed with attemptsMade 2' },
    );

    const job = await getSheetsQueue().getJob(`sheet:sync:${appointment._id}`);
    assert.ok(job, 'completed job still inspectable');
    assert.equal(calls.append.length, 3 + 1, '3 withRetry calls on attempt 1 + 1 on attempt 2');
    // BullMQ attemptsMade counts total attempts: 1 failure + 1 success = 2.
    assert.equal(job.attemptsMade, 2, 'job was retried once at the BullMQ level');
    assert.equal((await Appointment.findById(appointment._id).lean()).status, 'confirmed');
  });

  it('after max retries the job lands in the dead-letter queue and the worker survives', async () => {
    failAll = true;
    failCount = 0;

    const appointment = await book('+923004000004', '10:00');

    // Wait for the exhausted job to be moved to the DLQ.
    await waitFor(async () => (await getSheetsDeadQueue().getJob(`sheet:dead:${appointment._id}`)) != null, {
      label: 'job in dead-letter queue',
    });

    const dlqJob = await getSheetsDeadQueue().getJob(`sheet:dead:${appointment._id}`);
    assert.ok(dlqJob, 'exhausted job present in the DLQ');
    assert.equal(dlqJob.data.appointmentId, String(appointment._id));

    // The failed sync must never have blocked or rolled back the booking:
    // the appointment stays confirmed in the DB.
    const doc = await Appointment.findById(appointment._id).lean();
    assert.equal(doc.status, 'confirmed', 'RULES.md §9: sheet failure never rolls back the appointment');
    assert.equal(doc.sheetSyncStatus, 'failed');

    // Worker process is still alive and healthy: recovery + a fresh job for the
    // same appointment processes fine (this also models the self-heal path).
    failAll = false;
    await enqueueSheetSync({ appointmentId: appointment._id, backoff: jobBackoff });
    await waitFor(
      async () => (await Appointment.findById(appointment._id).lean())?.sheetSyncStatus === 'synced',
      { label: 'worker recovered after DLQ' },
    );
  });
});
