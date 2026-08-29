import { DoctorConfig, WEEKDAYS } from '../../../src/models/DoctorConfig.model.js';
import { Appointment } from '../../../src/models/Appointment.model.js';
import { Patient } from '../../../src/models/Patient.model.js';
import { MessageLog } from '../../../src/models/MessageLog.model.js';
import { Conversation } from '../../../src/models/Conversation.model.js';
import { getInboundQueue, createInboundWorker } from '../../../src/queues/inboundMessage.queue.js';
import { enqueueInboundMessage } from '../../../src/queues/inboundMessage.queue.js';
import { redis } from '../../../src/config/redis.js';
import {
  noopEnqueueSheetSync,
  noopEnqueueNotifyDoctor,
  noopEnqueueNotifyPatientConfirmation,
  noopEnqueueScheduleReminders,
  noopRemoveReminderJobs,
} from '../../../src/services/booking.service.js';
import { getRuleForDate, generateDaySlots, invalidateDoctorConfigCache } from '../../../src/services/slot.service.js';

// Shared harness for the Phase 9 load tests. A full "conversation" is 3 turns:
//   1. patient asks for a date+time     → book_appointment { date, time }
//   2. patient gives name/phone/reason  → book_appointment { name, phone, reason }
//   3. patient confirms                 → confirm { value: true } → booked
// The scripted NLU keys its response off the MESSAGE TEXT (not a mutable
// counter), so a BullMQ retry re-runs the same turn deterministically.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Removes every record the harness's deterministic waMessageIds touch, so the
 * load tests are idempotent across runs. Without this, handleInbound's
 * refWaMessageId dedup (RULES.md §3) makes a re-run's jobs early-return as
 * duplicates and the suite silently books 0 appointments.
 */
export async function cleanupPhonePrefix(prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}`);
  await MessageLog.deleteMany({ phone: re });
  await Conversation.deleteMany({ phone: re });
  await Patient.deleteMany({ phone: re });
  await Appointment.deleteMany({ patientPhone: re });
  // The Redis `conv:{phone}` hot cache (conversation.memory.service.js) can hold
  // turns from an interrupted run; with a 30-min TTL it would otherwise poison
  // the next run, because appendUserTurn dedups by waMessageId and every job
  // would see the stale last user turn (observed as [3,3,3] + 0 appointments).
  const matches = [];
  await new Promise((resolve, reject) => {
    const stream = redis.scanStream({ match: `${'conv:'}${escaped}*`, count: 100 });
    stream.on('data', (keys) => matches.push(...keys));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  for (const key of matches) await redis.del(key);
}

export async function waitFor(cond, { timeout = 60_000, interval = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await cond();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

export function makeDoctorConfig({ doctorName, doctorPhone }) {
  return DoctorConfig.create({
    doctorName,
    doctorPhone,
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
}

/**
 * Scripted NLU that drives the 3-turn book flow and records the exact
 * per-phone processing order. Also measures peak concurrent NLU executions so
 * a test can prove the worker is NOT serializing conversations.
 *
 * @param {Array<{phone: string, turn: number}>} seen  ordering log (mutated)
 * @returns {{nlu: Function, peak: () => number, seen: Array}}
 */
export function makeScriptedNlu(seen) {
  let active = 0;
  let peak = 0;
  const nlu = async ({ phone, history }) => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      // A real await point so overlapping worker jobs genuinely interleave and
      // `peak` reflects true pipeline concurrency (the event loop otherwise
      // runs this synchronous body to completion one job at a time). 30ms is
      // wide enough that 5 workers reliably overlap despite scheduling jitter.
      await sleep(30);
      const last = [...history].reverse().find((turn) => turn.role !== 'assistant');
      const text = (last?.text || '').trim();
      if (text.startsWith('BOOK ')) {
        const [, date, time] = text.split(/\s+/);
        seen.push({ phone, turn: 1 });
        return { toolCall: { name: 'book_appointment', input: { date, time } } };
      }
      if (text.startsWith('NAME ')) {
        const name = text.replace('NAME ', '').trim();
        seen.push({ phone, turn: 2 });
        return { toolCall: { name: 'book_appointment', input: { name, phone, reason: 'checkup' } } };
      }
      if (text === 'YES') {
        seen.push({ phone, turn: 3 });
        return { toolCall: { name: 'confirm', input: { value: true } } };
      }
      throw new Error(`unexpected load-test message: ${text}`);
    } finally {
      active -= 1;
    }
  };
  return {
    nlu,
    seen,
    peak: () => peak,
  };
}

/** One full conversation's messages for a given slot + name. */
export function conversationMessages({ date, time, name }) {
  return [`BOOK ${date} ${time}`, `NAME ${name}`, 'YES'];
}

/**
 * Per-phone unique slot generator: distinct valid {date, time} across N phones.
 * Slots come from the ACTUAL grid (slotMinutes + buffer, breaks skipped) on
 * working days only (closed days/holidays skipped), because the booking path
 * now enforces the schedule at write time — a Sunday/holiday/break slot would
 * be rejected. `timesPerDay` is accepted for backward compatibility but the
 * per-day grid size is whatever the schedule yields.
 */
export function slotsFor(nPhones, { startDate, doctorConfig, timesPerDay = 24 }) {
  const slots = [];
  let dayOffset = 0;
  while (slots.length < nPhones) {
    const date = new Date(Date.parse(`${startDate}T00:00:00`) + dayOffset * 86_400_000)
      .toISOString()
      .slice(0, 10);
    dayOffset += 1;
    if (!doctorConfig || doctorConfig.holidays?.includes(date)) continue;
    const rule = getRuleForDate(doctorConfig, date);
    if (!rule) continue;
    for (const time of generateDaySlots(rule, doctorConfig.bufferMinutes || 0)) {
      if (slots.length >= nPhones) break;
      slots.push({ date, time });
    }
  }
  return slots;
}

/**
 * Enqueues one conversation per phone (N phones × 3 turns), starts a real
 * BullMQ worker (concurrency 5) wired to the scripted NLU, and resolves once
 * every job has completed.
 *
 * @param {Function} [onWorkerStarted]  awaited right after the worker is up and
 *   before waiting for the queue to drain — used by the under-load test to fire
 *   a 50-way same-slot race while the 100 conversations are still processing.
 *
 * @returns {Promise<{seen: Array, peak: number, failed: number, worker: Object}>}
 */
export async function runConversationLoad({ nPhones, phonePrefix, doctorConfig, startDate, onWorkerStarted }) {
  const seen = [];
  const scripted = makeScriptedNlu(seen);
  const phones = Array.from({ length: nPhones }, (_, i) => `${phonePrefix}${String(i).padStart(4, '0')}`);
  const slots = slotsFor(nPhones, { startDate, doctorConfig });

  // Enqueue ROUND-ROBIN across phones (all turn-1s, then all turn-2s, then all
  // turn-3s) so the worker's first N jobs belong to N DIFFERENT phones and real
  // parallelism is actually exercised. The per-phone FIFO lock is what keeps a
  // single patient's 3 turns strictly ordered despite the interleaving — which
  // is exactly what the ordering assertion verifies under load.
  for (let turn = 0; turn < 3; turn += 1) {
    for (let i = 0; i < nPhones; i += 1) {
      await enqueueInboundMessage({
        phone: phones[i],
        text: conversationMessages({ ...slots[i], name: `Load Patient ${i}` })[turn],
        waMessageId: `load-${phonePrefix}-${i}-${turn}`,
      });
    }
  }

  const worker = createInboundWorker({
    nlu: scripted.nlu,
    doctorConfig,
    sendMessage: async () => `out-${Math.random().toString(36).slice(2)}`,
    enqueueSheetSync: noopEnqueueSheetSync,
    enqueueNotifyDoctor: noopEnqueueNotifyDoctor,
    enqueueNotifyPatientConfirmation: noopEnqueueNotifyPatientConfirmation,
    enqueueScheduleReminders: noopEnqueueScheduleReminders,
    removeReminderJobs: noopRemoveReminderJobs,
  });

  if (onWorkerStarted) await onWorkerStarted();

  const queue = getInboundQueue();
  await waitFor(async () => {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    return counts.waiting === 0 && counts.active === 0 && counts.delayed === 0;
  }, { label: 'load queue drained', timeout: 120_000 });

  const failed = (await queue.getJobCounts('failed')).failed;
  return { seen, peak: scripted.peak(), failed, worker };
}

/** DB-side assertions shared by the load tests. */
export async function assertConversationResults({ doctorConfig, nPhones, seen, peak, failed }) {
  const appointments = await Appointment.find({ doctorId: doctorConfig._id }).lean();
  assertLoad(appointments.length === nPhones, `expected ${nPhones} appointments, got ${appointments.length}`);
  assertLoad(failed === 0, `expected 0 failed jobs, got ${failed}`);

  const tokenNos = appointments.map((a) => a.tokenNo);
  assertLoad(new Set(tokenNos).size === nPhones, 'tokenNos must all be unique');

  const seenByPhone = new Map();
  for (const entry of seen) {
    if (!seenByPhone.has(entry.phone)) seenByPhone.set(entry.phone, []);
    seenByPhone.get(entry.phone).push(entry.turn);
  }
  assertLoad(seenByPhone.size === nPhones, `all ${nPhones} phones must be seen by the NLU`);
  for (const [phone, turns] of seenByPhone) {
    assertLoad(
      JSON.stringify(turns) === JSON.stringify([1, 2, 3]),
      `per-phone FIFO ordering violated for ${phone}: ${JSON.stringify(turns)}`,
    );
  }
  assertLoad(peak >= 5, `worker must not serialize conversations (peak concurrency ${peak}, expected >= 5)`);
}

function assertLoad(condition, message) {
  if (!condition) throw new Error(message);
}

export { Appointment, Patient, invalidateDoctorConfigCache };
