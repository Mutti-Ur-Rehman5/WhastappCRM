import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { redis } from '../../src/config/redis.js';
import {
  generateDaySlots,
  getRuleForDate,
  isBufferClash,
  isSlotValid,
} from '../../src/services/slot.service.js';

after(async () => {
  // Importing slot.service.js pulls in the shared ioredis client; quit it so
  // this test subprocess exits cleanly (same pattern as conversation.memory.test).
  await redis.quit();
});

// Pure, synchronous parts of slot.service — no DB/Redis needed. The cached
// DoctorConfig read/write is exercised against the real Redis in the
// integration suite.

const config = {
  workingHours: [
    { day: 'monday', enabled: true, start: '09:00', end: '17:00', slotMinutes: 15, breaks: [] },
    { day: 'tuesday', enabled: true, start: '09:00', end: '17:00', slotMinutes: 30, breaks: [{ start: '13:00', end: '14:00' }] },
    { day: 'sunday', enabled: false, start: '09:00', end: '17:00', slotMinutes: 15, breaks: [] },
  ],
  holidays: ['2026-08-14'],
};

describe('isSlotValid (DESIGN.md §4)', () => {
  it('accepts a normal slot inside working hours', () => {
    assert.deepEqual(isSlotValid(config, '2026-08-03', '10:30'), { ok: true });
  });

  it('rejects a holiday', () => {
    assert.deepEqual(isSlotValid(config, '2026-08-14', '10:30'), { ok: false, reason: 'holiday' });
  });

  it('rejects a closed day (disabled weekday)', () => {
    assert.deepEqual(isSlotValid(config, '2026-08-09', '10:30'), { ok: false, reason: 'closed_day' });
  });

  it('rejects a missing weekday rule', () => {
    const noRule = { ...config, workingHours: [{ day: 'monday', enabled: true, start: '09:00', end: '17:00', slotMinutes: 15, breaks: [] }] };
    assert.deepEqual(isSlotValid(noRule, '2026-08-04', '10:30'), { ok: false, reason: 'closed_day' });
  });

  it('rejects before opening and at/after closing', () => {
    assert.deepEqual(isSlotValid(config, '2026-08-03', '08:59'), { ok: false, reason: 'outside_hours' });
    assert.deepEqual(isSlotValid(config, '2026-08-03', '17:00'), { ok: false, reason: 'outside_hours' });
    assert.deepEqual(isSlotValid(config, '2026-08-03', '17:01'), { ok: false, reason: 'outside_hours' });
  });

  it('accepts the boundary slots (opening and last valid)', () => {
    assert.deepEqual(isSlotValid(config, '2026-08-03', '09:00'), { ok: true });
    assert.deepEqual(isSlotValid(config, '2026-08-03', '16:45'), { ok: true });
  });

  it('rejects a time inside a break but accepts the break end boundary', () => {
    assert.deepEqual(isSlotValid(config, '2026-08-04', '13:00'), { ok: false, reason: 'break_time' });
    assert.deepEqual(isSlotValid(config, '2026-08-04', '13:59'), { ok: false, reason: 'break_time' });
    assert.deepEqual(isSlotValid(config, '2026-08-04', '14:00'), { ok: true });
  });

  it('handles a missing config', () => {
    assert.deepEqual(isSlotValid(null, '2026-08-03', '10:30'), { ok: false, reason: 'no_config' });
  });
});

describe('generateDaySlots (DESIGN.md §4)', () => {
  it('steps 09:00–17:00 by 15 minutes → 32 slots, first 09:00, last 16:45', () => {
    const rule = { start: '09:00', end: '17:00', slotMinutes: 15, breaks: [] };
    const slots = generateDaySlots(rule);
    assert.equal(slots.length, 32);
    assert.equal(slots[0], '09:00');
    assert.equal(slots.at(-1), '16:45');
    assert.equal(slots[1], '09:15');
  });

  it('excludes slots whose start falls inside a break', () => {
    const rule = { start: '09:00', end: '17:00', slotMinutes: 15, breaks: [{ start: '13:00', end: '14:00' }] };
    const slots = generateDaySlots(rule);
    assert.ok(!slots.includes('13:00'));
    assert.ok(!slots.includes('13:45'));
    assert.ok(slots.includes('14:00'), 'break end is a valid start');
    assert.equal(slots.length, 28);
  });

  it('honours a larger slotMinutes (30)', () => {
    const rule = { start: '09:00', end: '12:00', slotMinutes: 30, breaks: [] };
    assert.deepEqual(generateDaySlots(rule), ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('defaults slotMinutes to 15 when missing', () => {
    const rule = { start: '09:00', end: '10:00' };
    assert.deepEqual(generateDaySlots(rule), ['09:00', '09:15', '09:30', '09:45']);
  });

  it('steps the grid by slotMinutes + bufferMinutes (buffer enforcement)', () => {
    const rule = { start: '09:00', end: '10:00', slotMinutes: 15, breaks: [] };
    // buffer 5 → 20-min grid: 09:00, 09:20, 09:40 (09:20+20 = 09:40 <= 10:00).
    assert.deepEqual(generateDaySlots(rule, 5), ['09:00', '09:20', '09:40']);
  });

  it('buffer-stepped grid skips slot starts inside a break', () => {
    const rule = { start: '09:00', end: '17:00', slotMinutes: 15, breaks: [{ start: '13:00', end: '14:00' }] };
    const slots = generateDaySlots(rule, 5);
    assert.ok(!slots.includes('13:00'));
    assert.ok(!slots.includes('13:20'));
    assert.ok(slots.includes('14:00'), 'break end is a valid start on the buffer grid');
  });
});

describe('isBufferClash (buffer enforcement at booking time)', () => {
  it('rejects a new slot inside an active booking buffer window', () => {
    assert.equal(isBufferClash('09:00', '09:15', 15, 5), true, '09:15 is inside [09:00, 09:20)');
    assert.equal(isBufferClash('09:00', '09:19', 15, 5), true, '09:19 is just inside');
  });

  it('allows a slot exactly at the buffer boundary', () => {
    assert.equal(isBufferClash('09:00', '09:20', 15, 5), false, '09:20 = end of the buffer window');
  });

  it('allows a slot before the active window', () => {
    assert.equal(isBufferClash('09:00', '08:40', 15, 5), false, '08:40 ends before 09:00 starts');
  });

  it('allows the exact same start time (shared slot up to maxPerSlot)', () => {
    assert.equal(isBufferClash('09:00', '09:00', 15, 5), false, 'same-time slots are shared, not conflicted');
  });

  it('defaults duration/buffer to 15/0 when omitted', () => {
    assert.equal(isBufferClash('09:00', '09:10', undefined, undefined), true);
    assert.equal(isBufferClash('09:00', '09:15', undefined, undefined), false);
  });
});

describe('getRuleForDate', () => {
  it('returns the enabled weekday rule for an ISO date', () => {
    const rule = getRuleForDate(config, '2026-08-03'); // monday
    assert.equal(rule.day, 'monday');
  });

  it('returns null for a disabled weekday', () => {
    assert.equal(getRuleForDate(config, '2026-08-09'), null); // sunday
  });
});
