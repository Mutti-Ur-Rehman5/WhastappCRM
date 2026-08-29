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
import { MessageLog } from '../../src/models/MessageLog.model.js';
import { toUtcInstant } from '../../src/utils/datetime.util.js';
import { invalidateDoctorConfigCache } from '../../src/services/slot.service.js';
import { _setAdminDeps } from '../../src/controllers/appointment.controller.js';
import { closeInboundQueue } from '../../src/queues/inboundMessage.queue.js';
import { closeSheetsQueues } from '../../src/queues/sheetsSync.queue.js';
import { closeNotifyDoctorQueues } from '../../src/queues/notifyDoctor.queue.js';
import { closeNotifyPatientQueue } from '../../src/queues/notifyPatient.queue.js';
import { closeRemindersQueues } from '../../src/queues/reminders.queue.js';

// Phase 11 dashboard API (DESIGN.md §9): the new reschedule + available-slots
// endpoints and the config schedule-conflict warning, exercised over the real
// Express app with real Mongo + Redis. All external side-effects (sheets sync,
// doctor notify, reminders, WhatsApp) are injected as mocks (RULES.md §7) and
// the patient-facing clinic-change WhatsApp is asserted via the mock + the
// MessageLog row the controller writes through the real pipeline.

const DOCTOR_NAME = 'admin.dashboard.test.config';
const ADMIN_KEY = env.adminApiKey;
const AUTH = { 'X-Admin-Api-Key': ADMIN_KEY };

let server;
let baseUrl;
let config;
let patient;
let sent = [];
let buttonSends = [];
let pendingMarkerKey = null;
const createdIds = { patients: [], appointments: [], audits: [], messages: [] };

function api(path, { method = 'GET', body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...AUTH,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createAppointment({ tokenNo, date, time, status = 'confirmed', rescheduledFrom } = {}) {
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

before(async () => {
  await connectTestDb();
  _setAdminDeps({
    enqueueSheetSync: async () => null,
    enqueueNotifyDoctor: async () => null,
    enqueueScheduleReminders: async () => null,
    removeReminderJobs: async () => ({ removed: 0 }),
    sendTextMessage: async ({ to, text }) => {
      sent.push({ to, text });
      return `mock-wa-${sent.length}`;
    },
    sendInteractiveButtons: async ({ to, body, buttons }) => {
      buttonSends.push({ to, body, buttons });
      return `mock-wa-btn-${buttonSends.length}`;
    },
    enqueueRescheduleTimeout: async () => null,
    removeRescheduleTimeoutJob: async () => null,
  });

  // This suite owns the config table for its run (same pattern as the other
  // admin suites) so putConfig resolves OUR DoctorConfig row. The Redis cache
  // may hold a previous suite's config — drop it so getDoctorConfig rebuilds.
  await DoctorConfig.deleteMany({});
  await invalidateDoctorConfigCache();
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

  patient = await Patient.create({ name: 'Resched User', phone: '+923006666666' });
  createdIds.patients.push(patient._id.toString());

  // 300: active, will be rescheduled. 301: occupies 11:00 as a clash target.
  await createAppointment({ tokenNo: 300, date: '2099-07-01', time: '10:00' });
  await createAppointment({ tokenNo: 301, date: '2099-07-01', time: '11:00' });

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  _setAdminDeps({});
  if (pendingMarkerKey) await redis.del(pendingMarkerKey);
  await MessageLog.deleteMany({ phone: patient.phone });
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

describe('admin dashboard API', () => {
  describe('GET /api/appointments/:id/available-slots', () => {
    it('returns the schedule grid minus the appointment own slot and clashes', async () => {
      const appt = await Appointment.findOne({ tokenNo: 300 }).lean();
      const res = await api(`/api/appointments/${appt._id}/available-slots?date=2099-07-01`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.date, '2099-07-01');
      assert.equal(body.slotMinutes, 15);
      assert.ok(Array.isArray(body.slots) && body.slots.length > 0);
      assert.ok(!body.slots.includes('10:00'), 'own slot must not be offered');
      assert.ok(!body.slots.includes('11:00'), 'slot at capacity (token 301) must not be offered');
      // 13:00 break is excluded by the schedule grid.
      assert.ok(!body.slots.includes('13:00'), 'break time must not be offered');
      assert.ok(body.slots.includes('09:00'), 'a free morning slot is offered');
    });

    it('returns an empty list for a closed/holiday date', async () => {
      const appt = await Appointment.findOne({ tokenNo: 300 }).lean();
      const res = await api(`/api/appointments/${appt._id}/available-slots?date=2099-07-05`); // sunday
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.slots, []);
    });

    it('400s on a malformed date query', async () => {
      const appt = await Appointment.findOne({ tokenNo: 300 }).lean();
      const res = await api(`/api/appointments/${appt._id}/available-slots?date=07-01-2099`);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'VALIDATION_ERROR');
    });

    it('404s for an unknown appointment', async () => {
      const res = await api('/api/appointments/000000000000000000000000/available-slots?date=2099-07-01');
      assert.equal(res.status, 404);
    });
  });

  describe('PATCH /api/appointments/:id/reschedule', () => {
    it('proposes a reschedule (pending state + Redis reservation) and asks the patient via buttons', async () => {
      sent = [];
      buttonSends = [];
      const appt = await Appointment.findOne({ tokenNo: 300 }).lean();

      const res = await api(`/api/appointments/${appt._id}/reschedule`, {
        method: 'PATCH',
        body: { date: '2099-07-01', time: '09:30' },
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.reschedulePending, true);
      // The appointment must NOT move yet.
      assert.equal(body.appointment.status, 'confirmed');
      assert.equal(body.appointment.date, '2099-07-01');
      assert.equal(body.appointment.time, '10:00');
      assert.ok(body.pendingReschedule, 'response carries the pending reschedule');
      assert.equal(body.pendingReschedule.newDate, '2099-07-01');
      assert.equal(body.pendingReschedule.newTime, '09:30');
      assert.ok(body.pendingReschedule.token, 'opaque token embedded in the button ids');
      assert.ok(body.pendingReschedule.expiresAt, 'expiry timestamp set');

      const dbRow = await Appointment.findById(appt._id).lean();
      assert.equal(dbRow.status, 'confirmed', 'row stays confirmed until the patient answers');
      assert.ok(dbRow.pendingReschedule, 'pendingReschedule persisted on the row');
      assert.equal(String(dbRow.pendingReschedule.token), body.pendingReschedule.token);

      // The target slot is reserved in Redis while the patient decides.
      pendingMarkerKey = `pending:rs:${config._id}:2099-07-01:09:30`;
      const held = await redis.get(pendingMarkerKey);
      assert.equal(held, String(appt._id), 'Redis reservation holds the requesting appointment id');

      // The interactive YES/NO proposal went out through the injectable sender.
      assert.equal(buttonSends.length, 1);
      assert.equal(buttonSends[0].to, patient.phone);
      assert.match(buttonSends[0].body, /2099-07-01 at 09:30/);
      assert.equal(buttonSends[0].buttons.length, 2);
      assert.equal(buttonSends[0].buttons[0].title, 'Yes');
      assert.equal(buttonSends[0].buttons[1].title, 'No');
      assert.match(buttonSends[0].buttons[0].id, /^RS_YES_/);
      assert.match(buttonSends[0].buttons[1].id, /^RS_NO_/);
      assert.ok(buttonSends[0].buttons[0].id.includes(body.pendingReschedule.token));

      const log = await MessageLog.findOne({ phone: patient.phone, direction: 'out', body: buttonSends[0].body }).lean();
      assert.ok(log, 'proposal is recorded in MessageLog');
      createdIds.messages.push(String(log._id));

      const audits = await AuditLog.find({ entityId: appt._id, action: 'reschedule_requested' }).lean();
      assert.equal(audits.length, 1);
      assert.equal(audits[0].actor, 'admin', 'audit must record actor admin');
      assert.equal(audits[0].after.newDate, '2099-07-01');
      createdIds.audits.push(String(audits[0]._id));
    });

    it('409s when the target slot is already taken (incl. pending reservations)', async () => {
      // 09:30 is now held by token 300's pending reservation.
      const appt = await Appointment.findOne({ tokenNo: 301 }).lean();
      const res = await api(`/api/appointments/${appt._id}/reschedule`, {
        method: 'PATCH',
        body: { date: '2099-07-01', time: '09:30' },
      });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, 'SLOT_TAKEN');
    });

    it('409s when the appointment is not active', async () => {
      const done = await createAppointment({ tokenNo: 302, date: '2099-07-02', time: '10:00', status: 'completed' });
      const res = await api(`/api/appointments/${done._id}/reschedule`, {
        method: 'PATCH',
        body: { date: '2099-07-02', time: '11:00' },
      });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, 'APPOINTMENT_NOT_ACTIVE');
    });

    it('400s on a structurally invalid body', async () => {
      const appt = await Appointment.findOne({ tokenNo: 301 }).lean();
      const res = await api(`/api/appointments/${appt._id}/reschedule`, {
        method: 'PATCH',
        body: { date: '2099-07-01' },
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'VALIDATION_ERROR');
    });
  });

  describe('PUT /api/config schedule-conflict warnings', () => {
    it('reports future active bookings that the new hours no longer cover', async () => {
      // Narrow every working day so token 301 (11:00) falls outside hours.
      const res = await api('/api/config', {
        method: 'PUT',
        body: {
          workingHours: WEEKDAYS.map((day) => ({
            day,
            enabled: day !== 'sunday',
            start: '09:00',
            end: '10:30',
            slotMinutes: 15,
            breaks: [],
          })),
        },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.cacheInvalidated, true);
      assert.ok(body.scheduleConflicts, 'response must carry scheduleConflicts');
      assert.ok(body.scheduleConflicts.count >= 1);
      const tokens = body.scheduleConflicts.examples.map((e) => e.tokenNo);
      assert.ok(tokens.includes(301), 'the 11:00 booking must be listed as a conflict');
    });

    it('reports zero conflicts when the schedule still covers every booking', async () => {
      const res = await api('/api/config', {
        method: 'PUT',
        body: {
          workingHours: WEEKDAYS.map((day) => ({
            day,
            enabled: day !== 'sunday',
            start: '09:00',
            end: '17:00',
            slotMinutes: 15,
            breaks: [],
          })),
        },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.scheduleConflicts.count, 0);
    });
  });
});
