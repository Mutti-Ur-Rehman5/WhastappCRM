import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { redis } from '../../src/config/redis.js';
import { Appointment } from '../../src/models/Appointment.model.js';
import { AuditLog } from '../../src/models/AuditLog.model.js';
import { DoctorConfig, WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import { Patient } from '../../src/models/Patient.model.js';
import {
  bookAppointment,
  rescheduleAppointment,
  cancelAppointment,
  findUpcomingAppointments,
} from '../../src/services/booking.service.js';
import {
  SlotTakenError,
  ValidationError,
  AppointmentNotFoundError,
  AppointmentNotActiveError,
} from '../../src/utils/errors.js';

// Phase 5 DoD lives here: reschedule (single locked swap, linked via
// rescheduledFrom), cancel (idempotent), MEMORY.md §5 target resolution, and
// the concurrent cross-locking reschedule test (no deadlock, consistent DB).
// Real docker-compose Mongo replica set + Redis; nothing mocked.

const MY_CONFIG = 'reschedule.test.config';
const TEST_DATE = '2099-01-05';
const OTHER_DATE = '2099-01-06';
const CONC_DATE_1 = '2099-02-03';
const CONC_DATE_2 = '2099-02-04';

let config;
let patients;

function patientPhone(i) {
  return `+9230901${String(i).padStart(4, '0')}`;
}

async function assertConsistentDB({ doctorId, date, slots, originalIds, owners }) {
  for (const time of slots) {
    const count = await Appointment.countDocuments({
      doctorId,
      date,
      time,
      status: { $in: ['pending', 'confirmed'] },
    });
    assert.ok(count <= 1, `slot ${date} ${time} is not double-booked (count=${count})`);
  }
  const olds = await Appointment.find({ _id: { $in: originalIds } }).lean();
  for (const old of olds) {
    if (old.status === 'rescheduled') {
      const linked = await Appointment.countDocuments({ rescheduledFrom: old._id, status: 'confirmed' });
      assert.equal(linked, 1, `rescheduled appointment ${old._id} has exactly one linked replacement`);
    } else {
      assert.equal(old.status, 'confirmed', `untouched original stays confirmed (${old._id})`);
    }
  }
  for (const p of owners) {
    const confirmed = await Appointment.countDocuments({
      patientId: p._id,
      date,
      status: 'confirmed',
    });
    assert.equal(confirmed, 1, `patient ${p.phone} ends with exactly one confirmed appointment on ${date}`);
  }
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
  await Patient.deleteMany({ phone: { $regex: '^\\+9230901' } });
  patients = await Promise.all(
    Array.from({ length: 4 }, (_, i) => Patient.create({ name: `RS Patient ${i}`, phone: patientPhone(i) })),
  );
});

after(async () => {
  await Appointment.deleteMany({ doctorId: config._id });
  await Patient.deleteMany({ phone: { $regex: '^\\+9230901' } });
  await DoctorConfig.deleteMany({ doctorName: MY_CONFIG });
  await closeTestDb();
  await redis.quit();
});

describe('reschedule.service (real Mongo replica set + Redis)', () => {
  it('reschedules: old → rescheduled, new confirmed, linked via rescheduledFrom, fresh tokenNo', async () => {
    const old = await bookAppointment({
      doctorId: config._id,
      date: TEST_DATE,
      time: '09:00',
      patient: patients[0],
      reason: 'fever',
    });

    const { appointment: next, previous } = await rescheduleAppointment({
      appointmentId: old._id,
      newDate: TEST_DATE,
      newTime: '14:00',
    });

    assert.equal(String(previous._id), String(old._id));
    assert.equal(next.status, 'confirmed');
    assert.equal(next.date, TEST_DATE);
    assert.equal(next.time, '14:00');
    assert.equal(next.patientPhone, patients[0].phone);
    assert.ok(Number.isInteger(next.tokenNo) && next.tokenNo > 0);
    assert.notEqual(next.tokenNo, old.tokenNo, 'new appointment gets a fresh tokenNo');
    assert.equal(String(next.rescheduledFrom), String(old._id), 'new appointment links back to the old one');
    assert.ok(next.slotStart instanceof Date);

    const persistedOld = await Appointment.findById(old._id).lean();
    assert.equal(persistedOld.status, 'rescheduled', 'old appointment is marked rescheduled');

    const inOldSlot = await Appointment.countDocuments({ doctorId: config._id, date: TEST_DATE, time: '09:00', status: 'confirmed' });
    assert.equal(inOldSlot, 0, 'the old slot is free again');
    const inNewSlot = await Appointment.countDocuments({ doctorId: config._id, date: TEST_DATE, time: '14:00', status: 'confirmed' });
    assert.equal(inNewSlot, 1, 'the new slot holds exactly the new appointment');

    // Patient.history reflects the change (DESIGN.md §1.2).
    const patient = await Patient.findById(patients[0]._id).lean();
    const entries = patient.history.map((h) => ({ appointmentId: String(h.appointmentId), status: h.status }));
    assert.ok(entries.some((e) => e.appointmentId === String(old._id) && e.status === 'rescheduled'));
    assert.ok(entries.some((e) => e.appointmentId === String(next._id) && e.status === 'confirmed'));

    // RULES.md §6: audit rows for both the old and the new row.
    const audits = await AuditLog.find({ action: 'rescheduled', entityId: { $in: [old._id, next._id] } }).lean();
    assert.equal(audits.length, 2, 'reschedule writes an audit entry for old and new appointment');
    assert.ok(audits.every((a) => a.actor === 'patient'));
    const newAudit = audits.find((a) => String(a.entityId) === String(next._id));
    assert.deepEqual(
      { before: newAudit.before, after: newAudit.after },
      {
        before: { tokenNo: next.tokenNo, date: TEST_DATE, time: '14:00', status: 'confirmed', rescheduledFrom: null },
        after: {
          tokenNo: next.tokenNo,
          date: TEST_DATE,
          time: '14:00',
          status: 'confirmed',
          rescheduledFrom: old._id,
          slotStart: next.slotStart.toISOString(),
        },
      },
      'audit before/after snapshots capture the reschedule',
    );
  });

  it('rejects reschedule to an occupied slot with SlotTakenError and leaves the original untouched', async () => {
    const original = await bookAppointment({
      doctorId: config._id,
      date: TEST_DATE,
      time: '10:00',
      patient: patients[1],
      reason: 'checkup',
    });
    const blocker = await bookAppointment({
      doctorId: config._id,
      date: TEST_DATE,
      time: '11:00', // >=20 min from 10:00 so only the reschedule target is what clashes
      patient: patients[2],
      reason: 'other',
    });

    await assert.rejects(
      rescheduleAppointment({ appointmentId: original._id, newDate: TEST_DATE, newTime: '11:00' }),
      (err) => err instanceof SlotTakenError && err.code === 'SLOT_TAKEN' && err.date === TEST_DATE && err.time === '11:00',
    );

    const untouched = await Appointment.findById(original._id).lean();
    assert.equal(untouched.status, 'confirmed', 'original appointment is not modified');
    assert.equal(untouched.time, '10:00', 'original slot unchanged');
    assert.equal(untouched.tokenNo, original.tokenNo, 'original tokenNo unchanged');
    const blockerStill = await Appointment.findById(blocker._id).lean();
    assert.equal(blockerStill.status, 'confirmed', 'occupant untouched');

    const noNew = await Appointment.countDocuments({ doctorId: config._id, date: TEST_DATE, time: '11:00', status: 'confirmed' });
    assert.equal(noNew, 1, 'no extra appointment was created (only the blocker remains)');

    const patient = await Patient.findById(patients[1]._id).lean();
    assert.deepEqual(patient.history, [], 'failed reschedule writes nothing to Patient.history');

    const audits = await AuditLog.countDocuments({ action: 'rescheduled', entityId: original._id });
    assert.equal(audits, 0, 'no rescheduled audit entry for the untouched appointment');
  });

  it('cancels a confirmed appointment and is idempotent on double-cancel', async () => {
    const target = await bookAppointment({
      doctorId: config._id,
      date: TEST_DATE,
      time: '12:00',
      patient: patients[3],
      reason: 'follow-up',
    });

    const cancelled = await cancelAppointment({ appointmentId: target._id });
    assert.equal(cancelled.status, 'cancelled');

    // Second cancel: idempotent no-op (RULES.md §3), resolves without error.
    const again = await cancelAppointment({ appointmentId: target._id });
    assert.equal(again.status, 'cancelled');

    const audits = await AuditLog.find({ entityId: target._id, action: 'cancelled' }).lean();
    assert.equal(audits.length, 1, 'the idempotent second cancel writes no duplicate audit row');

    const patient = await Patient.findById(patients[3]._id).lean();
    assert.ok(
      patient.history.some((h) => String(h.appointmentId) === String(target._id) && h.status === 'cancelled'),
      'Patient.history marks the appointment cancelled',
    );
  });

  it('surfaces AppointmentNotFound / AppointmentNotActive / Validation errors cleanly', async () => {
    const missing = '64a0000000000000000000ff';
    await assert.rejects(cancelAppointment({ appointmentId: missing }), AppointmentNotFoundError);
    await assert.rejects(
      rescheduleAppointment({ appointmentId: missing, newDate: TEST_DATE, newTime: '09:00' }),
      AppointmentNotFoundError,
    );

    const completed = await bookAppointment({
      doctorId: config._id,
      date: OTHER_DATE,
      time: '09:00',
      patient: patients[0],
      reason: 'x',
    });
    await Appointment.updateOne({ _id: completed._id }, { $set: { status: 'completed' } });
    await assert.rejects(
      cancelAppointment({ appointmentId: completed._id }),
      (err) => err instanceof AppointmentNotActiveError && err.status === 'completed',
    );
    await assert.rejects(
      rescheduleAppointment({ appointmentId: completed._id, newDate: OTHER_DATE, newTime: '09:30' }),
      AppointmentNotActiveError,
    );

    await assert.rejects(
      rescheduleAppointment({ appointmentId: completed._id, newDate: OTHER_DATE }),
      ValidationError,
    );
    await assert.rejects(cancelAppointment({}), ValidationError);
  });

  it('findUpcomingAppointments returns only future confirmed appointments, sorted ascending (MEMORY.md §5)', async () => {
    const phone = '+92309010099';
    const patient = await Patient.create({ name: 'Upcoming Check', phone });
    // Past rows can no longer be created via bookAppointment (write-moment past
    // check), so seed one directly — the point here is findUpcomingAppointments
    // filtering, not how the row was created.
    const past = await Appointment.create({
      tokenNo: -99,
      doctorId: config._id,
      patientId: patient._id,
      patientName: 'Upcoming Check',
      patientPhone: phone,
      date: '2020-01-05',
      time: '10:00',
      slotStart: new Date('2020-01-05T05:00:00Z'),
      status: 'confirmed',
      reason: 'old',
    });
    const soon = await bookAppointment({ doctorId: config._id, date: OTHER_DATE, time: '10:00', patient, reason: 'soon' });
    const later = await bookAppointment({ doctorId: config._id, date: '2099-12-24', time: '12:00', patient, reason: 'later' });
    await cancelAppointment({ appointmentId: past._id });

    const upcoming = await findUpcomingAppointments({ patientPhone: phone });
    assert.deepEqual(
      upcoming.map((a) => String(a._id)),
      [String(soon._id), String(later._id)],
      'past + cancelled excluded; future confirmed only, ascending by slotStart',
    );
    assert.ok(upcoming.every((a) => a.status === 'confirmed'));
    await Patient.deleteOne({ _id: patient._id });
    await Appointment.deleteMany({ doctorId: config._id, patientId: patient._id });
  });

  it(
    'concurrent reschedules swapping into each other\'s slots: no deadlock (<5s), both fail cleanly, DB consistent',
    async () => {
      const a = await bookAppointment({ doctorId: config._id, date: CONC_DATE_1, time: '09:00', patient: patients[0], reason: 'swap' });
      const b = await bookAppointment({ doctorId: config._id, date: CONC_DATE_1, time: '09:40', patient: patients[1], reason: 'swap' });

      const start = Date.now();
      const results = await Promise.allSettled([
        rescheduleAppointment({ appointmentId: a._id, newDate: CONC_DATE_1, newTime: '09:40' }),
        rescheduleAppointment({ appointmentId: b._id, newDate: CONC_DATE_1, newTime: '09:00' }),
      ]);
      const elapsed = Date.now() - start;

      assert.ok(elapsed < 5000, `deadlock avoidance must complete in <5s, took ${elapsed}ms`);
      for (const r of results) {
        assert.equal(r.status, 'rejected');
        assert.ok(r.reason instanceof SlotTakenError, `expected SlotTakenError, got ${r.reason?.name || r.reason?.message}`);
      }
      await assertConsistentDB({
        doctorId: config._id,
        date: CONC_DATE_1,
        slots: ['09:00', '09:40'],
        originalIds: [a._id, b._id],
        owners: [patients[0], patients[1]],
      });
    },
  );

  it(
    'concurrent reschedules crossing lock order: no deadlock (<5s), any successes are linked, never a double-book',
    async () => {
      const c = await bookAppointment({ doctorId: config._id, date: CONC_DATE_2, time: '09:00', patient: patients[0], reason: 'cross' });
      const d = await bookAppointment({ doctorId: config._id, date: CONC_DATE_2, time: '09:20', patient: patients[1], reason: 'cross' });

      const start = Date.now();
      const results = await Promise.allSettled([
        // C (09:00) → 10:00: lock set {09:00, 10:00}
        rescheduleAppointment({ appointmentId: c._id, newDate: CONC_DATE_2, newTime: '10:00' }),
        // D (09:20) → 09:00: lock set {09:00, 09:20} — shares the 09:00 key
        rescheduleAppointment({ appointmentId: d._id, newDate: CONC_DATE_2, newTime: '09:00' }),
      ]);
      const elapsed = Date.now() - start;

      assert.ok(elapsed < 5000, `deadlock avoidance must complete in <5s, took ${elapsed}ms`);
      for (const r of results) {
        if (r.status === 'rejected') {
          assert.ok(r.reason instanceof SlotTakenError, `expected SlotTakenError, got ${r.reason?.name || r.reason?.message}`);
        }
      }
      await assertConsistentDB({
        doctorId: config._id,
        date: CONC_DATE_2,
        slots: ['09:00', '09:20', '10:00'],
        originalIds: [c._id, d._id],
        owners: [patients[0], patients[1]],
      });
    },
  );
});
