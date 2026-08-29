import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { app } from '../../src/app.js';
import { redis } from '../../src/config/redis.js';
import { env } from '../../src/config/env.js';
import { DoctorConfig, WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import { AuditLog } from '../../src/models/AuditLog.model.js';
import {
  DEFAULT_DOCTOR_CONFIG_KEY,
  doctorConfigKey,
  getDoctorConfig,
  isSlotValid,
  invalidateDoctorConfigCache,
} from '../../src/services/slot.service.js';
import { closeInboundQueue } from '../../src/queues/inboundMessage.queue.js';
import { closeSheetsQueues } from '../../src/queues/sheetsSync.queue.js';
import { closeNotifyDoctorQueues } from '../../src/queues/notifyDoctor.queue.js';
import { closeNotifyPatientQueue } from '../../src/queues/notifyPatient.queue.js';
import { closeRemindersQueues } from '../../src/queues/reminders.queue.js';

// Phase 10 DoD test: PUT /api/config updates working hours AND invalidates the
// Redis cache so the very next slot-validation call (i.e. the next booking
// attempt) sees the new hours — without a server restart. Also proves malformed
// config payloads are rejected with a clear 400.

const ADMIN_KEY = env.adminApiKey;
const AUTH = { 'X-Admin-Api-Key': ADMIN_KEY, 'Content-Type': 'application/json' };

let server;
let baseUrl;
let configId;

function daysFrom(start, end, slotMinutes = 15, breaks = []) {
  return WEEKDAYS.map((day) => ({
    day,
    enabled: day !== 'sunday',
    start,
    end,
    slotMinutes,
    breaks,
  }));
}

function api(path, { method = 'GET', body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: AUTH,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  await connectTestDb();
  // Own the whole config table so default-config resolution is deterministic.
  // The Redis cache may still hold a config row that a PREVIOUS suite created
  // (deleted here) — invalidate it so getDoctorConfig resolves OUR row.
  await DoctorConfig.deleteMany({});
  await invalidateDoctorConfigCache();
  const config = await DoctorConfig.create({
    doctorName: 'admin.config.test.config',
    doctorPhone: '+923001239997',
    timezone: 'Asia/Karachi',
    workingHours: daysFrom('09:00', '17:00', 15, [{ start: '13:00', end: '14:00' }]),
    holidays: ['2026-08-14'],
    bufferMinutes: 5,
    reminderOffsetsHours: [24, 2],
  });
  configId = config._id.toString();

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await AuditLog.deleteMany({ entity: 'config', entityId: configId });
  await DoctorConfig.deleteMany({});
  await closeInboundQueue();
  await closeSheetsQueues();
  await closeNotifyDoctorQueues();
  await closeNotifyPatientQueue();
  await closeRemindersQueues();
  await closeTestDb();
  await redis.quit();
});

describe('admin config API', () => {
  it('GET /api/config returns the current DoctorConfig', async () => {
    const res = await api('/api/config');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(String(body._id), configId);
    assert.equal(body.workingHours.length, 7);
    assert.equal(body.bufferMinutes, 5);
    assert.equal(body.maxPerSlot, 1);
    assert.deepEqual(body.reminderOffsetsHours, [24, 2]);
  });

  it('PUT /api/config updates working hours and the very next booking read sees them (cache invalidated)', async () => {
    // Prime the Redis cache with the OLD hours (09:00-17:00) — this is what a
    // booking attempt would currently see.
    const cachedBefore = await getDoctorConfig({ doctorId: configId });
    assert.equal(cachedBefore.workingHours.find((w) => w.day === 'monday').start, '09:00');
    const cachedRaw = await redis.get(doctorConfigKey(configId));
    assert.ok(cachedRaw, 'config is cached in Redis before the PUT');

    // Admin widens hours to 08:00-20:00 with 30-minute slots, no lunch break,
    // and raises per-slot capacity to 3 (which also retires the legacy 3-field
    // unique index so the second patient at the same slot can actually book).
    const res = await api('/api/config', {
      method: 'PUT',
      body: {
        workingHours: daysFrom('08:00', '20:00', 30),
        holidays: ['2026-08-14'],
        bufferMinutes: 10,
        maxPerSlot: 3,
        reminderOffsetsHours: [24, 2],
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cacheInvalidated, true);
    assert.equal(body.config.bufferMinutes, 10);
    assert.equal(body.config.maxPerSlot, 3);

    // Cache is gone immediately — no 5-minute TTL wait.
    assert.equal(await redis.get(doctorConfigKey(configId)), null);
    assert.equal(await redis.get(DEFAULT_DOCTOR_CONFIG_KEY), null);

    // The next booking attempt (getDoctorConfig + isSlotValid) sees the update.
    const fresh = await getDoctorConfig({ doctorId: configId });
    assert.equal(fresh.workingHours.find((w) => w.day === 'monday').start, '08:00');
    assert.equal(fresh.workingHours.find((w) => w.day === 'monday').end, '20:00');
    assert.equal(fresh.workingHours.find((w) => w.day === 'monday').slotMinutes, 30);
    // 18:00 was OUTSIDE the old hours (17:00 close) but is INSIDE the new ones.
    assert.deepEqual(isSlotValid(fresh, '2026-08-03', '18:00'), { ok: true });
    // And the old config really would have rejected it.
    assert.deepEqual(isSlotValid(cachedBefore, '2026-08-03', '18:00'), { ok: false, reason: 'outside_hours' });

    // The config change is audited with actor admin.
    const audit = await AuditLog.findOne({ entity: 'config', entityId: configId, action: 'config_updated' }).lean();
    assert.ok(audit);
    assert.equal(audit.actor, 'admin');
    assert.equal(audit.before.workingHours.find((w) => w.day === 'monday').start, '09:00');
    assert.equal(audit.after.workingHours.find((w) => w.day === 'monday').start, '08:00');
  });

  it('rejects invalid working-hours payloads with a clear 400', async () => {
    const badDay = { workingHours: [{ day: 'funday', start: '09:00', end: '17:00' }] };
    const badTime = { workingHours: [{ day: 'monday', start: '9:00', end: '17:00' }] };
    const endBeforeStart = { workingHours: [{ day: 'monday', start: '17:00', end: '09:00' }] };
    const overlappingBreaks = {
      workingHours: [
        { day: 'monday', start: '09:00', end: '17:00', breaks: [{ start: '09:00', end: '10:00' }, { start: '09:30', end: '10:30' }] },
      ],
    };
    const breakEndsBeforeStart = {
      workingHours: [{ day: 'monday', start: '09:00', end: '17:00', breaks: [{ start: '10:00', end: '09:00' }] }],
    };
    const breakOutsideWindow = {
      workingHours: [{ day: 'monday', start: '09:00', end: '17:00', breaks: [{ start: '17:30', end: '18:00' }] }],
    };
    const duplicateDay = {
      workingHours: [
        { day: 'monday', start: '09:00', end: '12:00' },
        { day: 'monday', start: '13:00', end: '17:00' },
      ],
    };
    const badHoliday = { workingHours: daysFrom('09:00', '17:00'), holidays: ['14-08-2026'] };
    const badBuffer = { bufferMinutes: -5 };
    const badMaxPerSlotZero = { maxPerSlot: 0 };
    const badMaxPerSlotTooHigh = { maxPerSlot: 21 };
    const badReminderOffset = { reminderOffsetsHours: [999] };
    const disallowedField = { workingHours: daysFrom('09:00', '17:00'), doctorName: 'hacker' };

    const cases = [
      ['invalid day name', badDay, /day/],
      ['non-24h time format', badTime, /HH:mm/],
      ['end before start', endBeforeStart, /end must be after start/],
      ['overlapping breaks', overlappingBreaks, /overlap/],
      ['break end before break start', breakEndsBeforeStart, /break end must be after break start/],
      ['break outside working window', breakOutsideWindow, /inside working hours/],
      ['duplicate day', duplicateDay, /more than once/],
      ['malformed holiday date', badHoliday, /YYYY-MM-DD/],
      ['negative bufferMinutes', badBuffer, /bufferMinutes/],
      ['zero maxPerSlot', badMaxPerSlotZero, /maxPerSlot/],
      ['maxPerSlot above 20', badMaxPerSlotTooHigh, /maxPerSlot/],
      ['out-of-range reminder offset', badReminderOffset, /reminderOffsetsHours/],
      ['disallowed field (doctorName)', disallowedField, /doctorName/],
    ];

    for (const [label, payload, pattern] of cases) {
      const res = await api('/api/config', { method: 'PUT', body: payload });
      assert.equal(res.status, 400, `${label} must be rejected with 400`);
      const body = await res.json();
      assert.equal(body.code, 'VALIDATION_ERROR', label);
      assert.ok(pattern.test(body.error), `${label}: error "${body.error}" should match ${pattern}`);
    }

    // Nothing from the invalid attempts may have landed.
    const doc = await DoctorConfig.findById(configId).lean();
    assert.equal(doc.bufferMinutes, 10, 'config must be unchanged after invalid PUTs');
    assert.equal(doc.workingHours.find((w) => w.day === 'monday').start, '08:00');
  });
});
