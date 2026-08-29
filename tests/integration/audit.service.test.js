import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { redis } from '../../src/config/redis.js';
import { Appointment } from '../../src/models/Appointment.model.js';
import { AuditLog } from '../../src/models/AuditLog.model.js';
import { MessageLog } from '../../src/models/MessageLog.model.js';
import { DoctorConfig, WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import { Patient } from '../../src/models/Patient.model.js';
import {
  bookAppointment,
  rescheduleAppointment,
  cancelAppointment,
} from '../../src/services/booking.service.js';
import { getAppointmentLifecycle } from '../../src/services/audit.service.js';

// Phase 8 DoD lives here: one appointment's full lifecycle — booked →
// rescheduled → cancelled — must be reconstructable from AuditLog + MessageLog
// ALONE, in correct chronological order, with no other source of truth.
// Runs against the real local replica set + Redis (same as booking.service.test).

const MY_CONFIG = 'audit.test.config';
const BOOK_DATE = '2099-03-05';
const RESCHEDULE_DATE = '2099-03-06';
const RUN_DIGITS = Date.now().toString().slice(-8);
const PHONE = `+9231${RUN_DIGITS}00`; // unique patient phone for this run

let config;
let patient;
let beforeTs;

async function countAudits(entityId, action) {
  return AuditLog.countDocuments({ entity: 'appointment', entityId, action });
}

before(async () => {
  await connectTestDb();
  await DoctorConfig.deleteMany({ doctorName: MY_CONFIG });
  config = await DoctorConfig.create({
    doctorName: MY_CONFIG,
    doctorPhone: '+923001239996',
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
  patient = await Patient.create({ name: 'Audit Test Patient', phone: PHONE });
  beforeTs = new Date(Date.now() - 60_000); // deliberately before every operation
});

after(async () => {
  await Appointment.deleteMany({ doctorId: config._id });
  await Patient.deleteMany({ phone: PHONE });
  await AuditLog.deleteMany({});
  await MessageLog.deleteMany({ phone: PHONE });
  await DoctorConfig.deleteMany({ doctorName: MY_CONFIG });
  await closeTestDb();
  await redis.quit();
});

describe('audit.service lifecycle reconstruction (real Mongo + Redis)', () => {
  it('reconstructs booked → rescheduled → cancelled purely from AuditLog + MessageLog', async () => {
    // --- the patient asks, gets a confirmation, and books -------------------
    await MessageLog.create({
      phone: PHONE,
      direction: 'in',
      channel: 'whatsapp',
      body: 'book 11:00 on 2099-03-05 please',
      waMessageId: `wamid.audit.in.${RUN_DIGITS}`,
      ts: beforeTs,
    });
    const original = await bookAppointment({
      doctorId: config._id,
      date: BOOK_DATE,
      time: '11:00',
      patient,
      reason: 'follow-up',
    });
    const bookedAudits = await AuditLog.find({ entityId: original._id, action: 'booked' }).lean();
    assert.equal(bookedAudits.length, 1, 'exactly one booked audit row');
    assert.equal(bookedAudits[0].actor, 'patient');
    assert.equal(bookedAudits[0].after.status, 'confirmed');
    assert.equal(bookedAudits[0].after.patientPhone, PHONE);

    // --- patient reschedules to a new slot -----------------------------------
    const { appointment: next } = await rescheduleAppointment({
      appointmentId: original._id,
      newDate: RESCHEDULE_DATE,
      newTime: '12:00',
    });

    const oldReschedule = await AuditLog.find({ entityId: original._id, action: 'rescheduled' }).lean();
    assert.equal(oldReschedule.length, 1, 'exactly one rescheduled row for the old appointment');
    assert.deepEqual(oldReschedule[0].before, {
      tokenNo: original.tokenNo,
      date: BOOK_DATE,
      time: '11:00',
      status: 'confirmed',
    });
    assert.equal(oldReschedule[0].after.status, 'rescheduled');

    const newReschedule = await AuditLog.find({ entityId: next._id, action: 'rescheduled' }).lean();
    assert.equal(newReschedule.length, 1, 'exactly one rescheduled row for the new appointment');
    assert.equal(newReschedule[0].before.status, 'confirmed');
    assert.equal(newReschedule[0].after.status, 'confirmed');
    assert.equal(String(newReschedule[0].after.rescheduledFrom), String(original._id));

    // --- patient cancels the rescheduled appointment -------------------------
    const cancelled = await cancelAppointment({ appointmentId: next._id });
    const cancelAudits = await AuditLog.find({ entityId: next._id, action: 'cancelled' }).lean();
    assert.equal(cancelAudits.length, 1, 'exactly one cancelled audit row');
    assert.equal(cancelAudits[0].before.status, 'confirmed');
    assert.equal(cancelAudits[0].after.status, 'cancelled');
    assert.equal(String(cancelled._id), String(next._id));

    // --- the patient's later chat message (arrives after everything) ---------
    await MessageLog.create({
      phone: PHONE,
      direction: 'in',
      channel: 'whatsapp',
      body: 'ok thank you',
      waMessageId: `wamid.audit.in.${RUN_DIGITS}.2`,
      ts: new Date(Date.now() + 60_000), // deliberately after every operation
    });

    // --- Phase 8 DoD: reconstruct from the logs alone -------------------------
    const oldLife = await getAppointmentLifecycle({ appointmentId: original._id, patientPhone: PHONE });
    assert.deepEqual(
      oldLife.events.filter((e) => e.type === 'audit').map((e) => e.action),
      ['booked', 'rescheduled'],
      'old appointment lifecycle: booked then rescheduled',
    );

    const nextLife = await getAppointmentLifecycle({ appointmentId: next._id, patientPhone: PHONE });
    assert.deepEqual(
      nextLife.events.filter((e) => e.type === 'audit').map((e) => e.action),
      ['rescheduled', 'cancelled'],
      'new appointment lifecycle: rescheduled then cancelled',
    );

    // Merged stream: first the opening message, then the audit events, then the
    // closing message — sorted by ts. The explicit ±60s offsets make the
    // interleaving deterministic regardless of how long the writes take.
    const { events } = nextLife;
    const types = events.map((e) => e.type);
    assert.ok(types.length >= 3);
    assert.equal(events[0].type, 'message');
    assert.equal(events[0].direction, 'in');
    assert.equal(events[0].body, 'book 11:00 on 2099-03-05 please');
    assert.ok(
      events.slice(1, -1).every((e) => e.type === 'audit'),
      'audit events sit between the patient messages in the merged stream',
    );
    assert.equal(events.at(-1).type, 'message');
    assert.equal(events.at(-1).body, 'ok thank you');
    const timestamps = events.map((e) => new Date(e.ts).getTime());
    assert.deepEqual(
      timestamps,
      [...timestamps].sort((a, b) => a - b),
      'events must be in strict chronological order',
    );
    assert.equal(nextLife.sources.audit, 2);
    assert.equal(nextLife.sources.message, 2);
  });
});
