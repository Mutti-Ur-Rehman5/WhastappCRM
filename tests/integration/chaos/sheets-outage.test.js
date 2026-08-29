import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../../helpers/db.js';
import { redis } from '../../../src/config/redis.js';
import { Appointment } from '../../../src/models/Appointment.model.js';
import { Patient } from '../../../src/models/Patient.model.js';
import { DoctorConfig } from '../../../src/models/DoctorConfig.model.js';
import { bookAppointment } from '../../../src/services/booking.service.js';
import { upsertSheetRow } from '../../../src/services/sheets.service.js';
import { processSheetSyncJob } from '../../../src/queues/sheetsSync.queue.js';
import { createCircuitBreaker } from '../../../src/utils/circuitBreaker.util.js';
import { makeDoctorConfig } from '../load/helpers.js';
import { invalidateDoctorConfigCache } from '../../../src/services/slot.service.js';

// DESIGN.md §10 / RULES.md §9: the Sheet is a READ-MIRROR. A Sheets outage must
// never affect the committed appointment — it retries with backoff, records
// sheetSyncStatus='failed' for the self-heal monitor, and lets the queue job
// fail (→ DLQ) without touching the confirmed booking.

function httpError(message, status) {
  const err = new Error(message);
  err.response = { status };
  return err;
}

function flakyClient(failuresBeforeSuccess) {
  let calls = 0;
  return {
    spreadsheets: {
      values: {
        append: async () => {
          calls += 1;
          if (calls <= failuresBeforeSuccess) throw httpError('Sheets API 500 (chaos)', 500);
          return { data: { updates: { updatedRange: 'Appointments!A9:H9' } } };
        },
        update: async () => {
          throw httpError('unexpected update call', 500);
        },
      },
    },
    calls: () => calls,
  };
}

function alwaysFailingClient() {
  return {
    spreadsheets: {
      values: {
        append: async () => {
          throw httpError('Sheets API 500 (chaos)', 500);
        },
        update: async () => {
          throw httpError('Sheets API 500 (chaos)', 500);
        },
      },
    },
  };
}

// Fresh breaker per test so this chaos suite never pollutes the real singleton.
function chaosBreaker() {
  return createCircuitBreaker('sheets-chaos', async ({ call }) => call());
}

let config;
let patient;
let appointment;

before(async () => {
  await connectTestDb();
  await DoctorConfig.deleteMany({ doctorName: 'sheets-chaos.config' });
  config = await makeDoctorConfig({ doctorName: 'sheets-chaos.config', doctorPhone: '+923001239983' });
  await invalidateDoctorConfigCache();
  await Appointment.deleteMany({ doctorId: config._id });
  patient = await Patient.create({ name: 'Sheets Chaos', phone: '+923099123003' });
  appointment = await bookAppointment({
    doctorId: config._id,
    date: '2099-08-04',
    time: '10:00',
    patient,
    reason: 'chaos',
  });
});

after(async () => {
  await Appointment.deleteMany({ doctorId: config._id });
  await Patient.deleteMany({ phone: '+923099123003' });
  await DoctorConfig.deleteMany({ doctorName: 'sheets-chaos.config' });
  await closeTestDb();
  await redis.quit();
});

describe('chaos: Google Sheets outage → appointment stays valid (DESIGN.md §10, RULES.md §9)', () => {
  it('retry + backoff recovers from transient 5xx and marks the row synced', async () => {
    const client = flakyClient(2);
    const job = { id: 'sheets-chaos-job-1', data: { appointmentId: String(appointment._id) } };
    const result = await processSheetSyncJob(job, {
      upsert: (appt) =>
        upsertSheetRow(appt, {
          sheetsClient: client,
          retryOptions: { attempts: 3, baseDelayMs: 5, jitterMs: 0 },
          breaker: chaosBreaker(),
        }),
    });

    assert.equal(result.ok, true);
    assert.equal(client.calls(), 3, 'a transient 5xx must be retried with backoff');

    const reloaded = await Appointment.findById(appointment._id).lean();
    assert.equal(reloaded.status, 'confirmed', 'a Sheet failure must never change the appointment');
    assert.equal(reloaded.sheetSyncStatus, 'synced');
    assert.equal(reloaded.sheetRowId, '9');
  });

  it('a permanent Sheets outage fails the sync job but the appointment stays confirmed', async () => {
    const job = { id: 'sheets-chaos-job-2', data: { appointmentId: String(appointment._id) } };
    await assert.rejects(
      processSheetSyncJob(job, {
        upsert: (appt) =>
          upsertSheetRow(appt, {
            sheetsClient: alwaysFailingClient(),
            retryOptions: { attempts: 3, baseDelayMs: 5, jitterMs: 0 },
            breaker: chaosBreaker(),
          }),
      }),
      /Sheets API 500/,
    );

    const reloaded = await Appointment.findById(appointment._id).lean();
    assert.equal(reloaded.status, 'confirmed', 'appointment must remain valid in the DB');
    assert.equal(reloaded.sheetSyncStatus, 'failed', 'the failure must be recorded for the self-heal monitor');
  });
});
