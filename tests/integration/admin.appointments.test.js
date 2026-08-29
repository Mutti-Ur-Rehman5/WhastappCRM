import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { app } from '../../src/app.js';
import { redis } from '../../src/config/redis.js';
import { env } from '../../src/config/env.js';
import { DoctorConfig, WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import { Patient } from '../../src/models/Patient.model.js';
import { Appointment } from '../../src/models/Appointment.model.js';
import { AuditLog } from '../../src/models/AuditLog.model.js';
import { toUtcInstant } from '../../src/utils/datetime.util.js';
import { _setAdminDeps } from '../../src/controllers/appointment.controller.js';
import { closeInboundQueue } from '../../src/queues/inboundMessage.queue.js';
import { closeSheetsQueues } from '../../src/queues/sheetsSync.queue.js';
import { closeNotifyDoctorQueues } from '../../src/queues/notifyDoctor.queue.js';
import { closeNotifyPatientQueue } from '../../src/queues/notifyPatient.queue.js';
import { closeRemindersQueues } from '../../src/queues/reminders.queue.js';

// Phase 10 admin API (DESIGN.md §9): /api/appointments over the REAL Express
// app with real Mongo + Redis, keyed by the X-Admin-Api-Key header. Covers the
// DoD: 401 on every route without the key, filtering/pagination, PATCH limited
// to status/notes (structural fields rejected), and DELETE that cancels rather
// than hard-deletes, all writing AuditLog rows with actor 'admin'.

const DOCTOR_NAME = 'admin.appointments.test.config';
const ADMIN_KEY = env.adminApiKey;
const AUTH = { 'X-Admin-Api-Key': ADMIN_KEY };

let server;
let baseUrl;
let config;
const createdIds = { patients: [], appointments: [], audits: [] };
const sheetSyncCalls = [];

function api(path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...AUTH,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createAppointment({ tokenNo, date, time, status = 'confirmed', patient, rescheduledFrom }) {
  const appointment = await Appointment.create({
    tokenNo,
    doctorId: config._id,
    patientId: patient._id,
    patientName: patient.name,
    patientPhone: patient.phone,
    date,
    time,
    slotStart: toUtcInstant(date, time),
    status,
    ...(rescheduledFrom ? { rescheduledFrom } : {}),
  });
  createdIds.appointments.push(appointment._id.toString());
  return appointment;
}

async function makePatient(name, phone) {
  const patient = await Patient.create({ name, phone });
  createdIds.patients.push(patient._id.toString());
  return patient;
}

before(async () => {
  await connectTestDb();
  // Phase 11: DELETE/reschedule enqueue sheets/notify jobs and send the
  // patient a WhatsApp notice — mock all of it (RULES.md §7: no real network).
  _setAdminDeps({
    enqueueSheetSync: async (p) => sheetSyncCalls.push(p),
    enqueueNotifyDoctor: async () => null,
    enqueueScheduleReminders: async () => null,
    removeReminderJobs: async () => ({ removed: 0 }),
    sendTextMessage: async () => null,
  });
  // This suite owns the whole config table: the admin config controller
  // resolves the DEFAULT config (single-doctor v1), so a leftover config from
  // another suite must not be first.
  await DoctorConfig.deleteMany({});
  await Appointment.deleteMany({});
  await Patient.deleteMany({});
  config = await DoctorConfig.create({
    doctorName: DOCTOR_NAME,
    doctorPhone: '+923001239999',
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

  const ali = await makePatient('Ali Raza', '+923001111111');
  const bilal = await makePatient('Bilal Khan', '+923002222222');
  const sana = await makePatient('Sana Malik', '+923003333333');
  const ayesha = await makePatient('Ayesha', '+923004444444');
  await createAppointment({ tokenNo: 100, date: '2099-05-10', time: '10:00', patient: ali });
  await createAppointment({ tokenNo: 101, date: '2099-05-10', time: '11:00', status: 'completed', patient: bilal });
  await createAppointment({ tokenNo: 102, date: '2099-05-11', time: '09:30', patient: ali });
  await createAppointment({ tokenNo: 103, date: '2099-05-11', time: '12:00', status: 'no-show', patient: sana });
  await createAppointment({ tokenNo: 104, date: '2099-05-12', time: '16:00', patient: ayesha });
  // An ACTIVE but past-dated appointment — hidden in the live view, shown with showPast=true.
  await createAppointment({ tokenNo: 300, date: '2020-01-01', time: '10:00', patient: ayesha });

  // A reschedule chain for the detail endpoint: 200 is the original (it got
  // marked 'rescheduled' when 201 replaced it), 201 replaced it.
  const chainPatient = await makePatient('Chain User', '+923005555555');
  const original = await createAppointment({ tokenNo: 200, date: '2099-05-20', time: '10:00', status: 'rescheduled', patient: chainPatient });
  await createAppointment({
    tokenNo: 201,
    date: '2099-05-21',
    time: '11:00',
    patient: chainPatient,
    rescheduledFrom: original._id,
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  _setAdminDeps({});
  await AuditLog.deleteMany({ entityId: { $in: createdIds.appointments } });
  await Appointment.deleteMany({ _id: { $in: createdIds.appointments } });
  await Patient.deleteMany({ _id: { $in: createdIds.patients } });
  await DoctorConfig.deleteMany({ doctorName: DOCTOR_NAME });
  await closeInboundQueue();
  await closeSheetsQueues();
  await closeNotifyDoctorQueues();
  await closeNotifyPatientQueue();
  await closeRemindersQueues();
  await closeTestDb();
  await redis.quit();
});

describe('admin appointments API', () => {
  describe('auth: every admin route rejects a missing/bad API key with 401', () => {
    const sampleId = '000000000000000000000000';

    it('rejects unauthenticated requests on every admin route', async () => {
      const cases = [
        ['GET', '/api/appointments'],
        ['GET', `/api/appointments/${sampleId}`],
        ['PATCH', `/api/appointments/${sampleId}`, { status: 'completed' }],
        ['DELETE', `/api/appointments/${sampleId}`],
        ['GET', '/api/config'],
        ['PUT', '/api/config', { bufferMinutes: 10 }],
      ];
      for (const [method, path, body] of cases) {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        assert.equal(res.status, 401, `${method} ${path} must 401 without a key`);
        assert.deepEqual(await res.json(), { error: 'Unauthorized' });
      }
    });

    it('rejects a wrong key on the same routes', async () => {
      const res = await fetch(`${baseUrl}/api/appointments`, {
        headers: { 'X-Admin-Api-Key': 'wrong-key' },
      });
      assert.equal(res.status, 401);
    });
  });

  describe('GET /api/appointments', () => {
    it('live view lists only active (pending/confirmed) upcoming appointments', async () => {
      const res = await api('/api/appointments');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.pagination.total, 4);
      assert.equal(body.pagination.limit, 50);
      assert.equal(body.pagination.offset, 0);
      assert.equal(body.data.length, 4);
      // History (completed/no-show/rescheduled) and the past-dated row are hidden.
      const tokenNos = body.data.map((a) => a.tokenNo);
      assert.deepEqual(tokenNos.sort((a, b) => a - b), [100, 102, 104, 201]);
    });

    it('showPast=true includes past-dated and history rows', async () => {
      const res = await api('/api/appointments?showPast=true');
      const body = await res.json();
      assert.equal(body.pagination.total, 8);
      const tokenNos = body.data.map((a) => a.tokenNo).sort((a, b) => a - b);
      assert.deepEqual(tokenNos, [100, 101, 102, 103, 104, 200, 201, 300]);
    });

    it('showPast=false drops a past-dated ACTIVE appointment (time has passed)', async () => {
      const res = await api('/api/appointments?showPast=false');
      const body = await res.json();
      assert.equal(body.pagination.total, 4);
      assert.ok(!body.data.some((a) => a.tokenNo === 300));
    });

    it('filters by status', async () => {
      const res = await api('/api/appointments?status=confirmed');
      const body = await res.json();
      const tokenNos = body.data.map((a) => a.tokenNo).sort((a, b) => a - b);
      assert.deepEqual(tokenNos, [100, 102, 104, 201]);
    });

    it('an explicit history status filter overrides the active-only default', async () => {
      const res = await api('/api/appointments?status=cancelled');
      const body = await res.json();
      assert.equal(body.pagination.total, 0);
    });

    it('filters by exact date', async () => {
      const res = await api('/api/appointments?date=2099-05-10');
      const body = await res.json();
      assert.equal(body.pagination.total, 1);
      assert.ok(body.data.every((a) => a.date === '2099-05-10'));
    });

    it('filters by case-insensitive patient name substring', async () => {
      const res = await api('/api/appointments?patientName=ALI');
      const body = await res.json();
      assert.equal(body.pagination.total, 2);
      assert.ok(body.data.every((a) => /ali/i.test(a.patientName)));
    });

    it('filters by patient phone substring', async () => {
      const res = await api('/api/appointments?patientPhone=92300111');
      const body = await res.json();
      assert.equal(body.pagination.total, 2);
      assert.ok(body.data.every((a) => a.patientPhone === '+923001111111'));
    });

    it('paginates with limit/offset without overlap', async () => {
      const page1 = await (await api('/api/appointments?limit=2&offset=0')).json();
      const page2 = await (await api('/api/appointments?limit=2&offset=2')).json();
      assert.equal(page1.data.length, 2);
      assert.equal(page2.data.length, 2);
      assert.equal(page1.pagination.total, 4);
      assert.equal(page2.pagination.total, 4);
      const ids1 = page1.data.map((a) => String(a._id));
      const ids2 = page2.data.map((a) => String(a._id));
      assert.ok(ids1.every((id) => !ids2.includes(id)), 'pages must not overlap');
    });

    it('rejects an invalid status filter with 400', async () => {
      const res = await api('/api/appointments?status=booked');
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, 'VALIDATION_ERROR');
    });
  });

  describe('GET /api/appointments/:id', () => {
    it('returns full detail including the rescheduledFrom chain (oldest first)', async () => {
      const chainAppt = await Appointment.findOne({ tokenNo: 201 }).lean();
      const res = await api(`/api/appointments/${chainAppt._id}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.tokenNo, 201);
      assert.equal(String(body.rescheduledFrom), String(chainAppt.rescheduledFrom));
      assert.equal(body.rescheduledFromChain.length, 1);
      assert.equal(body.rescheduledFromChain[0].tokenNo, 200);
    });

    it('returns an empty chain when there is no rescheduledFrom', async () => {
      const appt = await Appointment.findOne({ tokenNo: 100 }).lean();
      const body = await (await api(`/api/appointments/${appt._id}`)).json();
      assert.deepEqual(body.rescheduledFromChain, []);
    });

    it('404s for a non-existent id', async () => {
      const res = await api('/api/appointments/000000000000000000000000');
      assert.equal(res.status, 404);
      assert.equal((await res.json()).code, 'APPOINTMENT_NOT_FOUND');
    });

    it('400s for a malformed id', async () => {
      const res = await api('/api/appointments/not-an-id');
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'VALIDATION_ERROR');
    });
  });

  describe('PATCH /api/appointments/:id', () => {
    it('updates status only and audits it with actor admin', async () => {
      const appt = await Appointment.findOne({ tokenNo: 100 }).lean();
      const res = await api(`/api/appointments/${appt._id}`, { method: 'PATCH', body: { status: 'completed' } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'completed');
      assert.equal(body.notes, undefined);

      const audit = await AuditLog.findOne({ entityId: appt._id, action: 'status_changed_by_admin' }).lean();
      assert.ok(audit, 'an admin status-change audit row exists');
      assert.equal(audit.actor, 'admin');
      assert.deepEqual(audit.before, { status: 'confirmed' });
      assert.deepEqual(audit.after, { status: 'completed' });

      // The status flip also triggers a same-time sheets sync (same queue as
      // every other write path).
      assert.ok(
        sheetSyncCalls.some((c) => String(c.appointmentId) === String(appt._id)),
        'a status change enqueues a sheets sync for that appointment',
      );
    });

    it('updates notes only and audits it with actor admin', async () => {
      const appt = await Appointment.findOne({ tokenNo: 102 }).lean();
      const res = await api(`/api/appointments/${appt._id}`, { method: 'PATCH', body: { notes: 'Walk-in, cash' } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.notes, 'Walk-in, cash');

      const audit = await AuditLog.findOne({ entityId: appt._id, action: 'notes_changed_by_admin' }).lean();
      assert.ok(audit);
      assert.equal(audit.actor, 'admin');
      assert.equal(audit.after.notes, 'Walk-in, cash');
    });

    it('rejects a direct date/time/patient change with 400 (RULES.md §3 — no bypass)', async () => {
      const appt = await Appointment.findOne({ tokenNo: 103 }).lean();
      const res = await api(`/api/appointments/${appt._id}`, {
        method: 'PATCH',
        body: { status: 'confirmed', date: '2099-06-01' },
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, 'VALIDATION_ERROR');
      assert.ok(/date/.test(body.error), `error should mention the rejected field: ${body.error}`);

      const unchanged = await Appointment.findById(appt._id).lean();
      assert.equal(unchanged.status, 'no-show');
      assert.equal(unchanged.date, '2099-05-11');
    });

    it('rejects an invalid status value with 400', async () => {
      const appt = await Appointment.findOne({ tokenNo: 104 }).lean();
      const res = await api(`/api/appointments/${appt._id}`, { method: 'PATCH', body: { status: 'booked' } });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'VALIDATION_ERROR');
    });

    it('404s for a non-existent appointment', async () => {
      const res = await api('/api/appointments/000000000000000000000000', {
        method: 'PATCH',
        body: { notes: 'x' },
      });
      assert.equal(res.status, 404);
    });
  });

  describe('DELETE /api/appointments/:id', () => {
    it('cancels (does NOT hard-delete) and audits with actor admin', async () => {
      const appt = await Appointment.findOne({ tokenNo: 104 }).lean();
      const res = await api(`/api/appointments/${appt._id}`, { method: 'DELETE' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.cancelled, true);
      assert.equal(body.status, 'cancelled');

      // The row still exists — status flipped, never removed (audit trail).
      const after = await Appointment.findById(appt._id).lean();
      assert.ok(after, 'appointment must still exist after admin cancel');
      assert.equal(after.status, 'cancelled');

      const audit = await AuditLog.findOne({ entityId: appt._id, action: 'cancelled' }).lean();
      assert.ok(audit, 'a cancel audit row exists');
      assert.equal(audit.actor, 'admin');
      assert.equal(audit.before.status, 'confirmed');
      assert.equal(audit.after.status, 'cancelled');
    });

    it('404s for a non-existent appointment', async () => {
      const res = await api('/api/appointments/000000000000000000000000', { method: 'DELETE' });
      assert.equal(res.status, 404);
    });

    it('409s when the appointment is not in a cancelable state', async () => {
      const appt = await Appointment.findOne({ tokenNo: 101 }).lean(); // completed
      const res = await api(`/api/appointments/${appt._id}`, { method: 'DELETE' });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, 'APPOINTMENT_NOT_ACTIVE');
    });
  });
});
