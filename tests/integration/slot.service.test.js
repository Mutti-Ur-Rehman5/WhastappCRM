import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { redis } from '../../src/config/redis.js';
import { DoctorConfig, WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import {
  DEFAULT_DOCTOR_CONFIG_KEY,
  doctorConfigKey,
  generateDaySlots,
  getDoctorConfig,
  invalidateDoctorConfigCache,
  isSlotValid,
} from '../../src/services/slot.service.js';

// Real Mongo + Redis (docker-compose). Domain/config memory (MEMORY.md §1):
// DoctorConfig is cached in Redis with a 5-min TTL and invalidated on update.
// doctorName is unique to this file so it never collides with other suites.

const MY_CONFIG = 'slot.test.config';
let config;

async function seedConfig() {
  await DoctorConfig.deleteMany({ doctorName: MY_CONFIG });
  config = await DoctorConfig.create({
    doctorName: MY_CONFIG,
    doctorPhone: '+923001239998',
    timezone: 'Asia/Karachi',
    workingHours: WEEKDAYS.map((day) => ({
      day,
      enabled: day !== 'sunday',
      start: '09:00',
      end: '17:00',
      slotMinutes: 15,
      breaks: [{ start: '13:00', end: '14:00' }],
    })),
    holidays: ['2026-08-14'],
    bufferMinutes: 5,
  });
}

before(async () => {
  await connectTestDb();
  await seedConfig();
  await invalidateDoctorConfigCache();
});

after(async () => {
  await DoctorConfig.deleteMany({ doctorName: MY_CONFIG });
  await invalidateDoctorConfigCache();
  await closeTestDb();
  await redis.quit();
});

describe('slot.service (real Mongo + Redis)', () => {
  it('isSlotValid checks holidays, working hours and breaks against the seeded config', () => {
    assert.deepEqual(isSlotValid(config, '2026-08-03', '10:30'), { ok: true });
    assert.deepEqual(isSlotValid(config, '2026-08-14', '10:30'), { ok: false, reason: 'holiday' });
    assert.deepEqual(isSlotValid(config, '2026-08-09', '10:30'), { ok: false, reason: 'closed_day' });
    assert.deepEqual(isSlotValid(config, '2026-08-03', '08:00'), { ok: false, reason: 'outside_hours' });
    assert.deepEqual(isSlotValid(config, '2026-08-03', '17:00'), { ok: false, reason: 'outside_hours' });
    assert.deepEqual(isSlotValid(config, '2026-08-03', '13:30'), { ok: false, reason: 'break_time' });
    assert.deepEqual(isSlotValid(config, '2026-08-03', '14:00'), { ok: true });
  });

  it('generateDaySlots for the seeded Monday rule steps by slotMinutes+buffer (20 min → 21 slots, no break slot)', () => {
    const rule = config.workingHours.find((w) => w.day === 'monday');
    const slots = generateDaySlots(rule, config.bufferMinutes);
    assert.equal(slots.length, 21);
    assert.equal(slots[0], '09:00');
    assert.equal(slots.at(-1), '16:40');
    assert.ok(!slots.includes('13:00') && !slots.includes('13:45'));
    assert.ok(slots.includes('14:00'));
  });

  it('getDoctorConfig reads from DB and caches in Redis (5-min TTL)', async () => {
    const fromService = await getDoctorConfig({ doctorId: config._id.toString() });
    assert.equal(String(fromService._id), String(config._id));
    assert.equal(fromService.workingHours.length, 7);

    const raw = await redis.get(doctorConfigKey(config._id.toString()));
    assert.ok(raw, 'config was written to the Redis cache');
    const cached = JSON.parse(raw);
    assert.equal(String(cached._id), String(config._id));
  });

  it('serves the cached copy until invalidated (MEMORY.md §1)', async () => {
    // Change working hours in Mongo directly (simulates an admin update that
    // forgets to invalidate).
    await DoctorConfig.findByIdAndUpdate(config._id, { $set: { 'workingHours.0.start': '08:00' } });

    // Redis still holds the OLD copy → the service must return the old hours.
    const stale = await getDoctorConfig({ doctorId: config._id.toString() });
    assert.equal(stale.workingHours[0].start, '09:00', 'cache serves stale copy before invalidation');

    // Invalidate → next read reflects the change immediately.
    await invalidateDoctorConfigCache({ doctorId: config._id.toString() });
    const fresh = await getDoctorConfig({ doctorId: config._id.toString() });
    assert.equal(fresh.workingHours[0].start, '08:00', 'invalidation makes the update visible on the next booking');

    // Restore so later assertions in this file see the canonical config.
    await DoctorConfig.findByIdAndUpdate(config._id, { $set: { 'workingHours.0.start': '09:00' } });
    await invalidateDoctorConfigCache({ doctorId: config._id.toString() });
  });

  it('resolves the default (single-doctor v1) config and invalidates its cache key too', async () => {
    // getDoctorConfig() without doctorId caches under the DEFAULT key.
    const def = await getDoctorConfig();
    assert.ok(def, 'a default config resolves');
    const raw = await redis.get(DEFAULT_DOCTOR_CONFIG_KEY);
    assert.ok(raw, 'default config is cached under the default key');

    await invalidateDoctorConfigCache();
    const gone = await redis.get(DEFAULT_DOCTOR_CONFIG_KEY);
    assert.equal(gone, null, 'default cache key is cleared on invalidation');
  });
});
