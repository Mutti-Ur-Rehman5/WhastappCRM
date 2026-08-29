import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { redis } from '../../src/config/redis.js';
import { Appointment } from '../../src/models/Appointment.model.js';
import { AuditLog } from '../../src/models/AuditLog.model.js';
import { DoctorConfig, WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import { Patient } from '../../src/models/Patient.model.js';
import { bookAppointment, checkSlotBookable } from '../../src/services/booking.service.js';
import { generateDaySlots, getRuleForDate } from '../../src/services/slot.service.js';
import { SlotTakenError, ValidationError } from '../../src/utils/errors.js';

// THE Phase 4 DoD lives here: 50 parallel bookAppointment() calls for the exact
// same {doctorId, date, time} must yield exactly 1 success and 49
// SlotTakenErrors — reliably. Runs against the REAL docker-compose Mongo
// replica set + Redis; nothing is mocked (that is the point of this phase).
// doctorName/phones are unique to this file so parallel test suites don't
// collide, and dates are far-future so this file's slots never overlap
// another suite's.

const MY_CONFIG = 'booking.test.config';
const TEST_DATE = '2099-01-05'; // Monday — working day, no holiday in this config
const OTHER_DATE = '2099-01-06'; // Tuesday — fresh day for the parallelism check

const N_PATIENTS = 50;
const CONCURRENT_ITERATIONS = 5;
// 20-min grid (15-min slots + 5-min buffer): each iteration's winner must not
// buffer-clash with the previous iteration's still-active winner.
const CONCURRENT_TIMES = ['09:00', '09:20', '09:40', '10:00', '10:20'];

let config;
let patients;

function patientPhone(i) {
  return `+9230900${String(i).padStart(4, '0')}`;
}

before(async () => {
  await connectTestDb();
  await DoctorConfig.deleteMany({ doctorName: MY_CONFIG });
  config = await DoctorConfig.create({
    doctorName: MY_CONFIG,
    doctorPhone: '+923001239995',
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
  // Clear this file's leftovers from a previous run (scoped to our own doctorId).
  await Appointment.deleteMany({ doctorId: config._id });
  patients = await Promise.all(
    Array.from({ length: N_PATIENTS }, (_, i) =>
      Patient.create({ name: `Mock Patient ${i}`, phone: patientPhone(i) }),
    ),
  );
});

after(async () => {
  await Appointment.deleteMany({ doctorId: config._id });
  await Patient.deleteMany({ phone: { $in: patients.map((p) => p.phone) } });
  await DoctorConfig.deleteMany({ doctorName: MY_CONFIG });
  await closeTestDb();
  await redis.quit();
});

describe('booking.service (real Mongo replica set + Redis)', () => {
  it('books a slot atomically: confirmed status, tokenNo, audit entry, slotStart derived', async () => {
    const appointment = await bookAppointment({
      doctorId: config._id,
      date: TEST_DATE,
      time: '11:00',
      patient: patients[0],
      reason: 'fever',
    });

    assert.equal(appointment.status, 'confirmed');
    assert.equal(appointment.patientName, 'Mock Patient 0');
    assert.equal(appointment.patientPhone, patientPhone(0));
    assert.ok(Number.isInteger(appointment.tokenNo) && appointment.tokenNo > 0);
    assert.ok(appointment.slotStart instanceof Date);

    const persisted = await Appointment.findById(appointment._id).lean();
    assert.equal(persisted.slotStart.toISOString(), appointment.slotStart.toISOString());

    const audit = await AuditLog.findOne({ entity: 'appointment', entityId: appointment._id, action: 'booked' }).lean();
    assert.ok(audit, 'booking writes its AuditLog entry in the same transaction (RULES.md §6)');
    assert.equal(audit.actor, 'patient');
  });

  it('rejects a second booking for the same slot with SlotTakenError', async () => {
    const time = '11:45'; // >=20 min from the 11:00 booking so the buffer check is not what rejects it
    await bookAppointment({ doctorId: config._id, date: TEST_DATE, time, patient: patients[1] });
    await assert.rejects(
      bookAppointment({ doctorId: config._id, date: TEST_DATE, time, patient: patients[2] }),
      (err) => err instanceof SlotTakenError && err.code === 'SLOT_TAKEN',
    );
  });

  it('frees a slot when the occupying appointment is cancelled', async () => {
    const time = '12:15';
    const first = await bookAppointment({ doctorId: config._id, date: TEST_DATE, time, patient: patients[3] });
    await Appointment.updateOne({ _id: first._id }, { $set: { status: 'cancelled' } });

    const second = await bookAppointment({ doctorId: config._id, date: TEST_DATE, time, patient: patients[4] });
    assert.equal(second.status, 'confirmed');
    assert.notEqual(second.tokenNo, first.tokenNo);
  });

  it('throws ValidationError for malformed input before touching the lock', async () => {
    await assert.rejects(
      bookAppointment({ doctorId: config._id, date: TEST_DATE, patient: patients[5] }),
      ValidationError,
    );
    await assert.rejects(
      bookAppointment({ doctorId: config._id, date: TEST_DATE, time: '12:00', patient: { name: 'x' } }),
      ValidationError,
    );
  });

  it('defense in depth: rejects a slot inserted outside the booking service (lock bypass)', async () => {
    const time = '12:30';
    // Simulate a rogue write that bypassed booking.service entirely — the
    // in-transaction clash check still catches it.
    await Appointment.create({
      tokenNo: -1,
      doctorId: config._id,
      patientId: patients[6]._id,
      patientName: 'Rogue',
      patientPhone: patientPhone(6),
      date: TEST_DATE,
      time,
      slotStart: new Date(),
      status: 'confirmed',
    });

    await assert.rejects(
      bookAppointment({ doctorId: config._id, date: TEST_DATE, time, patient: patients[7] }),
      (err) => err instanceof SlotTakenError,
    );
  });

  it(
    `CRITICAL: ${N_PATIENTS} concurrent bookings for the same slot → exactly 1 success, ${N_PATIENTS - 1} SlotTakenError` +
      ` (×${CONCURRENT_ITERATIONS} iterations)`,
    async () => {
      for (let iteration = 0; iteration < CONCURRENT_ITERATIONS; iteration += 1) {
        const time = CONCURRENT_TIMES[iteration];

        const results = await Promise.allSettled(
          patients.map((patient) =>
            bookAppointment({ doctorId: config._id, date: TEST_DATE, time, patient, reason: 'concurrency' }),
          ),
        );

        const successes = results.filter((r) => r.status === 'fulfilled');
        const failures = results.filter((r) => r.status === 'rejected');

        assert.equal(successes.length, 1, `iteration ${iteration + 1}: exactly one booking must win`);
        assert.equal(
          failures.length,
          N_PATIENTS - 1,
          `iteration ${iteration + 1}: all other callers must fail`,
        );
        for (const f of failures) {
          assert.ok(
            f.reason instanceof SlotTakenError,
            `iteration ${iteration + 1}: expected SlotTakenError, got ${f.reason?.name || f.reason?.message}`,
          );
        }

        const winner = successes[0].value;
        assert.equal(winner.status, 'confirmed');
        assert.ok(Number.isInteger(winner.tokenNo) && winner.tokenNo > 0);
        assert.ok(winner.slotStart instanceof Date);

        const inDb = await Appointment.countDocuments({ doctorId: config._id, date: TEST_DATE, time });
        assert.equal(inDb, 1, `iteration ${iteration + 1}: exactly one Appointment row for the slot`);
      }
    },
  );

  it('concurrent bookings for DIFFERENT slots all succeed with unique, sequential tokenNos', async () => {
    const times = ['14:00', '14:20', '14:40', '15:00', '15:20', '15:40', '16:00', '16:20'];
    assert.ok(times.length <= N_PATIENTS);

    const results = await Promise.allSettled(
      times.map((time, i) =>
        bookAppointment({ doctorId: config._id, date: TEST_DATE, time, patient: patients[i], reason: 'parallel distinct slots' }),
      ),
    );

    for (const r of results) {
      assert.equal(r.status, 'fulfilled', `every distinct-slot booking must succeed, got ${r.reason?.message}`);
    }
    const tokenNos = results.map((r) => r.value.tokenNo);
    const unique = new Set(tokenNos);
    assert.equal(unique.size, times.length, 'tokenNos must all be unique');
    const sorted = [...tokenNos].sort((a, b) => a - b);
    // TokenNos come from one atomic global Counter (DESIGN.md §1.6). Under
    // `node --test` other test files run in parallel processes and consume from
    // the SAME counter, so a parallel suite may take a token in between ours:
    // the tokens are unique and strictly increasing, but cannot be asserted to
    // be adjacent. No-double-booking-shared-token is the real guarantee.
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(sorted[i] > sorted[i - 1], 'tokenNos must be strictly increasing, no duplicates');
    }
    const distinctSlots = await Appointment.countDocuments({ doctorId: config._id, date: TEST_DATE, time: { $in: times } });
    assert.equal(distinctSlots, times.length, 'all distinct slots are booked');
  });

  it('does not over-serialize: 20 unrelated slots book in parallel', async () => {
    // 20 unrelated slots on a fresh day, all fired at once. If the lock wrongly
    // serialized across different slots this would grind to a crawl. Times come
    // from the actual grid (15-min slots + 5-min buffer, break skipped) so every
    // slot is bookable and no two adjacent ones buffer-clash.
    const rule = getRuleForDate(config, OTHER_DATE);
    const times = generateDaySlots(rule, config.bufferMinutes).slice(0, 20);

    const results = await Promise.allSettled(
      times.map((time, i) =>
        bookAppointment({ doctorId: config._id, date: OTHER_DATE, time, patient: patients[i], reason: 'parallelism check' }),
      ),
    );
    const failures = results.filter((r) => r.status === 'rejected');
    assert.deepEqual(failures, [], `all 20 unrelated slots must book, got ${failures[0]?.reason?.message}`);
  });

  it('checkSlotBookable: schedule rules, past and occupancy are enforced pre-booking', async () => {
    // A date untouched by the parallel-book tests above (2099-01-05/06 are
    // heavily booked) so the free-slot and schedule-rule assertions never trip
    // on a capacity collision. 2099-01-07 is a Wednesday.
    const freshDate = '2099-01-07';

    // Schedule rules (write-moment isSlotValid is enforced in bookAppointment
    // too — see the reject tests below; here the read-only pre-check reports).
    assert.deepEqual(await checkSlotBookable({ doctorId: config._id, date: freshDate, time: '10:00', config }), {
      ok: true,
      reason: null,
    });
    assert.equal((await checkSlotBookable({ doctorId: config._id, date: freshDate, time: '08:00', config })).reason, 'outside_hours');
    assert.equal((await checkSlotBookable({ doctorId: config._id, date: freshDate, time: '13:00', config })).reason, 'break_time');
    assert.equal((await checkSlotBookable({ doctorId: config._id, date: '2099-01-04', time: '10:00', config })).reason, 'closed_day'); // 2099-01-04 is Sunday

    // in_the_past via the injected "now" (no DB dependency on the real clock).
    assert.equal(
      (await checkSlotBookable({ doctorId: config._id, date: freshDate, time: '10:00', config }, { todayRef: freshDate, nowTime: '10:00' })).reason,
      'in_the_past',
    );
    assert.equal(
      (await checkSlotBookable({ doctorId: config._id, date: freshDate, time: '10:00', config }, { todayRef: '2099-01-08', nowTime: '09:00' })).reason,
      'in_the_past',
    );
    assert.equal(
      (await checkSlotBookable({ doctorId: config._id, date: freshDate, time: '10:00', config }, { todayRef: '2099-01-06', nowTime: '23:59' })).ok,
      true,
    );

    // Occupancy: a slot already at capacity (maxPerSlot=1) is rejected, and one
    // inside another booking's buffer window is rejected too. 12:05 is an
    // off-grid time far from every grid slot on that day (so it can be booked),
    // and 12:15 is within its buffer window without overlapping the 13:00 break
    // (a slot starting there runs past the break and correctly rejects early).
    await bookAppointment({ doctorId: config._id, date: freshDate, time: '11:00', patient: patients[8], reason: 'occupier' });
    assert.equal((await checkSlotBookable({ doctorId: config._id, date: freshDate, time: '11:00', config })).reason, 'capacity');
    const offGrid = await bookAppointment({ doctorId: config._id, date: freshDate, time: '12:05', patient: patients[9], reason: 'off-grid' });
    assert.equal((await checkSlotBookable({ doctorId: config._id, date: freshDate, time: '12:15', config })).reason, 'buffer');
    // Reschedule: excluding the caller's OWN appointment clears the buffer clash
    // (the slot being moved is released in the same transaction).
    assert.equal(
      (await checkSlotBookable({ doctorId: config._id, date: freshDate, time: '12:15', config, excludeAppointmentId: offGrid._id })).ok,
      true,
    );
  });

  it('write-moment enforcement: bookAppointment rejects holiday, outside-hours, break and past slots', async () => {
    await assert.rejects(
      bookAppointment({ doctorId: config._id, date: '2099-01-05', time: '08:00', patient: patients[10] }),
      (err) => err instanceof SlotTakenError && err.reason === 'outside_hours',
    );
    await assert.rejects(
      bookAppointment({ doctorId: config._id, date: '2099-01-05', time: '13:30', patient: patients[10] }),
      (err) => err instanceof SlotTakenError && err.reason === 'break_time',
    );
    await assert.rejects(
      bookAppointment({ doctorId: config._id, date: '2099-01-04', time: '10:00', patient: patients[10] }),
      (err) => err instanceof SlotTakenError && err.reason === 'closed_day',
    );
    await assert.rejects(
      bookAppointment({ doctorId: config._id, date: '2020-01-06', time: '10:00', patient: patients[10] }),
      (err) => err instanceof SlotTakenError && err.reason === 'in_the_past',
    );
  });
});
