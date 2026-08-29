import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { redis } from '../../src/config/redis.js';
import { Appointment } from '../../src/models/Appointment.model.js';
import { DoctorConfig, WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import { Patient } from '../../src/models/Patient.model.js';
import { findNearestAvailable } from '../../src/services/suggestion.service.js';
import { toUtcInstant } from '../../src/utils/datetime.util.js';

// Nearest-slot search against the real Mongo replica set. doctorName/phones
// are unique to this file so parallel test suites never collide.

const MY_CONFIG = 'suggestion.test.config';
const MY_PHONE = '+923001239997';
const PATIENT_PHONE = '+923001239996';

const monday = dayjs().day(1).format('YYYY-MM-DD');
const saturday = dayjs(monday).add(5, 'day').format('YYYY-MM-DD');
const sunday = dayjs(monday).add(6, 'day').format('YYYY-MM-DD');
const holiday = dayjs(monday).add(7, 'day').format('YYYY-MM-DD'); // next Monday
const afterHoliday = dayjs(holiday).add(1, 'day').format('YYYY-MM-DD');

let config;
let patient;

async function createAppointment(date, time, { status = 'confirmed' } = {}) {
  return Appointment.create({
    tokenNo: 0, // tokens are set by booking.service; direct seed docs just need uniqueness-irrelevant values
    doctorId: config._id,
    patientId: patient._id,
    patientName: 'Suggestion Tester',
    patientPhone: PATIENT_PHONE,
    date,
    time,
    slotStart: toUtcInstant(date, time),
    reason: 'test',
    status,
  });
}

before(async () => {
  await connectTestDb();
  await DoctorConfig.deleteMany({ doctorName: MY_CONFIG });
  await Patient.deleteMany({ phone: PATIENT_PHONE });
  config = await DoctorConfig.create({
    doctorName: MY_CONFIG,
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
    holidays: [holiday],
    bufferMinutes: 5,
  });
  patient = await Patient.create({ name: 'Suggestion Tester', phone: PATIENT_PHONE });

  // Pre-booked slots on the starting Monday: 09:00, 09:15, 10:00 confirmed,
  // plus one pending (11:00) and one cancelled (12:00) for status filtering.
  await createAppointment(monday, '09:00');
  await createAppointment(monday, '09:15');
  await createAppointment(monday, '10:00');
  await createAppointment(monday, '11:00', { status: 'pending' });
  await createAppointment(monday, '12:00', { status: 'cancelled' });
});

after(async () => {
  await Appointment.deleteMany({ patientPhone: PATIENT_PHONE });
  await Patient.deleteMany({ phone: PATIENT_PHONE });
  await DoctorConfig.deleteMany({ doctorName: MY_CONFIG });
  await closeTestDb();
  await redis.quit();
});

describe('findNearestAvailable (DESIGN.md §4)', () => {
  it('returns the nearest free slots in order, skipping already-booked AND buffer-clashing ones', async () => {
    const result = await findNearestAvailable(String(config._id), monday, '09:00', 3, { config });
    // 09:00 booked; 09:20 is free on the grid but sits inside the buffer window
    // (15-min slot + 5-min buffer) of the off-grid 09:15 booking → skipped;
    // 10:00 booked. So the first genuinely bookable slots are 09:40/10:20/10:40.
    assert.deepEqual(
      result.map((r) => `${r.date} ${r.time}`),
      [`${monday} 09:40`, `${monday} 10:20`, `${monday} 10:40`],
    );
  });

  it('never suggests a grid slot that buffer-clashes with an off-grid booking', async () => {
    // 09:15 was seeded off-grid; 09:20 (on-grid) is inside its buffer window and
    // must not be offered as free even though no exact-time match exists.
    const result = await findNearestAvailable(String(config._id), monday, '09:00', 20, { config });
    const timesOnMonday = result.filter((r) => r.date === monday).map((r) => r.time);
    assert.ok(!timesOnMonday.includes('09:20'), '09:20 buffer-clashes with the 09:15 booking and must be skipped');
    assert.ok(timesOnMonday.includes('09:40'), '09:40 is clear of every booking and is suggested');
  });

  it('excludes past times on the current day', async () => {
    const result = await findNearestAvailable(String(config._id), monday, '10:30', 3, { config });
    assert.deepEqual(
      result.map((r) => r.time),
      ['10:40', '11:20', '11:40'], // 11:00 is pending → blocked
    );
  });

  it('respects the count parameter', async () => {
    const result = await findNearestAvailable(String(config._id), monday, '09:00', 2, { config });
    assert.equal(result.length, 2);
  });

  it('skips pending AND confirmed bookings but not cancelled ones', async () => {
    const result = await findNearestAvailable(String(config._id), monday, '09:00', 20, { config });
    const timesOnMonday = result.filter((r) => r.date === monday).map((r) => r.time);
    assert.ok(!timesOnMonday.includes('11:00'), 'pending slot is blocked');
    assert.ok(timesOnMonday.includes('12:00'), 'cancelled slot is reusable');
  });

  it('skips a holiday day entirely', async () => {
    const result = await findNearestAvailable(String(config._id), holiday, '09:00', 3, { config });
    assert.equal(result.length, 3);
    assert.ok(result.every((r) => r.date !== holiday), 'no suggestions on the holiday');
    assert.deepEqual(
      result.map((r) => `${r.date} ${r.time}`),
      [`${afterHoliday} 09:00`, `${afterHoliday} 09:20`, `${afterHoliday} 09:40`],
    );
  });

  it('crosses a closed day (Sunday) to the next working day', async () => {
    const result = await findNearestAvailable(String(config._id), saturday, '16:45', 2, { config });
    assert.deepEqual(
      result.map((r) => `${r.date} ${r.time}`),
      [`${afterHoliday} 09:00`, `${afterHoliday} 09:20`], // Sunday + next-Monday holiday skipped; 16:40 grid slot is past the 16:45 ref
    );
    assert.ok(!result.some((r) => r.date === sunday), 'Sunday never appears');
  });

  it('returns an empty array when no config exists', async () => {
    const result = await findNearestAvailable('64b000000000000000000000', monday, '09:00', 3, { config: null });
    assert.deepEqual(result, []);
  });
});
