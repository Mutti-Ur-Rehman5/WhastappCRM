import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { redis } from '../../src/config/redis.js';
import { Appointment } from '../../src/models/Appointment.model.js';
import { AuditLog } from '../../src/models/AuditLog.model.js';
import { Conversation } from '../../src/models/Conversation.model.js';
import { DoctorConfig, WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import { MessageLog } from '../../src/models/MessageLog.model.js';
import { Patient } from '../../src/models/Patient.model.js';
import { convKey } from '../../src/services/conversation.memory.service.js';
import { invalidateDoctorConfigCache } from '../../src/services/slot.service.js';
import { handleInbound } from '../../src/orchestrator/conversation.orchestrator.js';
import { bookAppointment } from '../../src/services/booking.service.js';
import { todayInClinicTimeZone } from '../../src/utils/datetime.util.js';

// Phase 5 conversations end-to-end through the real orchestrator (mocked NLU
// only, per RULES.md §7 — external APIs are mocked, Mongo/Redis are real):
// reschedule flow, ambiguous-cancel disambiguation (MEMORY.md §5), the
// "nothing to cancel" path, and slot-taken reschedule → alternatives.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, { timeout = 10000, interval = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await cond();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

let sendCalls = [];
let outboundSeq = 0;

async function mockSendMessage({ to, text }) {
  sendCalls.push({ to, text, at: Date.now() });
  outboundSeq += 1;
  return `wamid.out.rs.${outboundSeq}`;
}

function scriptedNlu(map) {
  return async ({ history }) => {
    const latest = history.at(-1)?.text ?? '';
    return { toolCall: map(latest) };
  };
}

async function mongoState(phone) {
  return Conversation.findOne({ phone }).lean();
}

const PHONE_RS = '+923001234611'; // reschedule end-to-end
const PHONE_AMB = '+923001234612'; // ambiguous cancel (2 upcoming)
const PHONE_NONE = '+923001234613'; // nothing to cancel
const PHONE_RSTAKEN = '+923001234614'; // reschedule into occupied slot
const PHONE_OCCUPIER = '+923001234615'; // holds a slot so PHONE_RSTAKEN clashes
const ALL_PHONES = [PHONE_RS, PHONE_AMB, PHONE_NONE, PHONE_RSTAKEN, PHONE_OCCUPIER];

let doctorConfig;

async function seedBooking(phone, date, time, name = 'Seed Patient') {
  const patient = await Patient.create({ name, phone });
  return bookAppointment({ doctorId: doctorConfig._id, date, time, patient, reason: 'checkup' });
}

async function resetSendCalls() {
  sendCalls = [];
}

// Each conversation test seeds its own appointments on "tomorrow" — wipe every
// trace between tests so leftover bookings from one scenario never collide with
// the next (e.g. the ambiguous-cancel test holds 12:00 for a later slot pick).
async function resetData() {
  await Conversation.deleteMany({ phone: { $in: ALL_PHONES } });
  await AuditLog.deleteMany({});
  await MessageLog.deleteMany({ phone: { $in: ALL_PHONES } });
  await Patient.deleteMany({ phone: { $in: ALL_PHONES } });
  await Appointment.deleteMany({ patientPhone: { $in: ALL_PHONES } });
  await Promise.all(ALL_PHONES.map((p) => redis.del(convKey(p))));
}

before(async () => {
  await connectTestDb();
  await resetData();
  await DoctorConfig.deleteMany({ doctorName: 'reschedule.orchestrator.test.config' });
  doctorConfig = await DoctorConfig.create({
    doctorName: 'reschedule.orchestrator.test.config',
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
    holidays: [],
    bufferMinutes: 5,
  });
  await invalidateDoctorConfigCache();
});

afterEach(async () => {
  await resetData();
});

after(async () => {
  await closeTestDb();
  await redis.quit();
});

describe('reschedule + cancel conversations (real Mongo+Redis, mocked NLU)', () => {
  it('reschedules end-to-end: auto-targets the single upcoming appointment, collects new datetime, confirms', async () => {
    await resetSendCalls();
    const todayRef = todayInClinicTimeZone();
    const tomorrow = dayjs(todayRef).add(1, 'day').format('YYYY-MM-DD');
    const apptOld = await seedBooking(PHONE_RS, tomorrow, '09:00', 'Reschedule Me');

    const nlu = scriptedNlu((text) => {
      if (text.startsWith('mera appointment reschedule')) return { name: 'reschedule_appointment', input: {} };
      if (text.includes('4 baje')) return { name: 'reschedule_appointment', input: { newDate: tomorrow, newTime: '16:00' } };
      if (text === 'yes') return { name: 'confirm', input: { value: true } };
      return { name: 'smalltalk_or_unclear', input: { replyHint: 'unexpected' } };
    });

    const turns = [
      ['mera appointment reschedule karna hai', 'COLLECTING_NEW_DATETIME'],
      ['kal 4 baje chalega', 'AWAITING_CONFIRMATION'],
      ['yes', 'IDLE'],
    ];

    for (let i = 0; i < turns.length; i += 1) {
      const [text, expectedState] = turns[i];
      const result = await handleInbound(
        { phone: PHONE_RS, text, waMessageId: `wamid.rs.${i}` },
        { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
      );
      assert.equal(result.state, expectedState, `turn ${i + 1} state`);
      const persisted = await waitFor(() => mongoState(PHONE_RS), { label: `persisted state after turn ${i + 1}` });
      assert.equal(persisted.state, expectedState, `turn ${i + 1} persisted state`);

      if (i === 0) {
        assert.equal(String(persisted.slots.targetAppointmentId), String(apptOld._id), 'single upcoming auto-targeted');
        assert.ok(sendCalls[i].text.includes('Which new day and what time'), 'asks for the new datetime');
      }
      if (i === 1) {
        assert.ok(sendCalls[i].text.includes('Reschedule karein'));
        assert.ok(sendCalls[i].text.includes(`New: ${tomorrow} at 16:00`));
      }
    }

    assert.ok(sendCalls[2].text.includes('Appointment rescheduled'), 'confirm reply confirms the reschedule');
    assert.ok(sendCalls[2].text.includes('New Token #'), 'confirm reply carries the new token');

    const oldDoc = await Appointment.findById(apptOld._id).lean();
    assert.equal(oldDoc.status, 'rescheduled');
    const next = await Appointment.findOne({ rescheduledFrom: apptOld._id }).lean();
    assert.ok(next, 'new appointment exists');
    assert.equal(next.status, 'confirmed');
    assert.equal(next.date, tomorrow);
    assert.equal(next.time, '16:00');
    assert.notEqual(next.tokenNo, apptOld.tokenNo);

    const patient = await Patient.findOne({ phone: PHONE_RS }).lean();
    const history = patient.history.map((h) => ({ appointmentId: String(h.appointmentId), status: h.status }));
    assert.ok(history.some((h) => h.appointmentId === String(apptOld._id) && h.status === 'rescheduled'));
    assert.ok(history.some((h) => h.appointmentId === String(next._id) && h.status === 'confirmed'));

    const audits = await AuditLog.find({ action: 'rescheduled', entityId: { $in: [apptOld._id, next._id] } }).lean();
    assert.equal(audits.length, 2, 'conversation reschedule produces audit rows for old + new');

    const final = await mongoState(PHONE_RS);
    assert.equal(final.state, 'IDLE');
    assert.equal(final.slots.date, undefined, 'slots cleared after conclusion');
  });

  it('ambiguous cancel (2 upcoming, no date): asks which one, then cancels only the chosen appointment', async () => {
    await resetSendCalls();
    const todayRef = todayInClinicTimeZone();
    const tomorrow = dayjs(todayRef).add(1, 'day').format('YYYY-MM-DD');
    const patientAmb = await Patient.create({ name: 'Ambig Patient', phone: PHONE_AMB });
    const a1 = await bookAppointment({ doctorId: doctorConfig._id, date: tomorrow, time: '10:00', patient: patientAmb, reason: 'x' });
    const a2 = await bookAppointment({ doctorId: doctorConfig._id, date: tomorrow, time: '12:00', patient: patientAmb, reason: 'y' });

    const nlu = scriptedNlu((text) => {
      if (text.startsWith('mera appointment cancel')) return { name: 'cancel_appointment', input: {} };
      if (text === '1') return { name: 'cancel_appointment', input: { targetDate: a1.date, targetTime: a1.time } };
      if (text === 'yes') return { name: 'confirm', input: { value: true } };
      return { name: 'smalltalk_or_unclear', input: { replyHint: 'unexpected' } };
    });

    // Turn 1: no date given + 2 upcoming → must ask, NOT cancel anything.
    let result = await handleInbound(
      { phone: PHONE_AMB, text: 'mera appointment cancel kar do', waMessageId: 'wamid.amb.0' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );
    assert.equal(result.state, 'IDENTIFY_TARGET_APPOINTMENT', 'asks which appointment first');
    assert.ok(sendCalls[0].text.includes('Konsi cancel karni hai'), 'disambiguation question asked');
    assert.ok(sendCalls[0].text.includes(String(a1.date)), 'lists appointment 1');
    assert.ok(sendCalls[0].text.includes(String(a2.date)), 'lists appointment 2');
    let stillConfirmed = await Appointment.countDocuments({ _id: { $in: [a1._id, a2._id] }, status: 'confirmed' });
    assert.equal(stillConfirmed, 2, 'nothing was cancelled on the disambiguation turn');

    // Turn 2: patient picks the first one.
    result = await handleInbound(
      { phone: PHONE_AMB, text: '1', waMessageId: 'wamid.amb.1' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );
    assert.equal(result.state, 'AWAITING_CONFIRMATION');
    assert.ok(sendCalls[1].text.includes('Cancel karein'));
    const persisted = await waitFor(() => mongoState(PHONE_AMB), { label: 'amb persisted' });
    assert.equal(String(persisted.slots.targetAppointmentId), String(a1._id), 'target pinned to the chosen appointment');

    // Turn 3: confirm → exactly the chosen one is cancelled.
    result = await handleInbound(
      { phone: PHONE_AMB, text: 'yes', waMessageId: 'wamid.amb.2' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );
    assert.equal(result.state, 'IDLE');
    assert.ok(sendCalls[2].text.includes('Appointment cancelled'));

    const a1doc = await Appointment.findById(a1._id).lean();
    const a2doc = await Appointment.findById(a2._id).lean();
    assert.equal(a1doc.status, 'cancelled', 'chosen appointment cancelled');
    assert.equal(a2doc.status, 'confirmed', 'other appointment untouched');

    const audits = await AuditLog.find({ action: 'cancelled', entityId: a1._id }).lean();
    assert.equal(audits.length, 1, 'exactly one cancellation audit row');
  });

  it('nothing to cancel: no upcoming appointments → friendly reply, state stays IDLE', async () => {
    await resetSendCalls();
    const todayRef = todayInClinicTimeZone();
    const nlu = scriptedNlu(() => ({ name: 'cancel_appointment', input: {} }));

    const result = await handleInbound(
      { phone: PHONE_NONE, text: 'mera appointment cancel kar do', waMessageId: 'wamid.none.0' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );

    assert.equal(result.state, 'IDLE');
    assert.ok(sendCalls[0].text.includes('no upcoming'), 'patient is told there is nothing to cancel');
    const persisted = await waitFor(() => mongoState(PHONE_NONE), { label: 'none persisted' });
    assert.equal(persisted.state, 'IDLE');
  });

  it('reschedule into an occupied slot: rejected EARLY at collection with alternatives, original untouched, then a free pick reschedules', async () => {
    await resetSendCalls();
    const todayRef = todayInClinicTimeZone();
    const tomorrow = dayjs(todayRef).add(1, 'day').format('YYYY-MM-DD');
    const apptOld = await seedBooking(PHONE_RSTAKEN, tomorrow, '09:00', 'Move Me');
    await seedBooking(PHONE_OCCUPIER, tomorrow, '11:00', 'Occupier');

    const nlu = scriptedNlu((text) => {
      if (text.startsWith('mera appointment reschedule')) return { name: 'reschedule_appointment', input: {} };
      if (text.includes('11 baje')) return { name: 'reschedule_appointment', input: { newDate: tomorrow, newTime: '11:00' } };
      if (text.includes('12 baje')) return { name: 'reschedule_appointment', input: { newDate: tomorrow, newTime: '12:00' } };
      if (text === 'yes') return { name: 'confirm', input: { value: true } };
      return { name: 'smalltalk_or_unclear', input: { replyHint: 'unexpected' } };
    });

    const result1 = await handleInbound(
      { phone: PHONE_RSTAKEN, text: 'mera appointment reschedule karna hai', waMessageId: 'wamid.tk.0' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );
    assert.equal(result1.state, 'COLLECTING_NEW_DATETIME');

    // Turn 2 proposes the occupied 11:00 slot: early validation rejects it AT
    // COLLECTION with reason-specific alternatives — it never reaches the
    // confirmation summary (item: early slot validation).
    const result2 = await handleInbound(
      { phone: PHONE_RSTAKEN, text: 'kal 11 baje karo', waMessageId: 'wamid.tk.1' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );
    assert.equal(result2.state, 'COLLECTING_NEW_DATETIME', 'stays collecting instead of confirming an occupied slot');
    assert.ok(sendCalls[1].text.includes('already taken'), 'reason-aware slot-taken reply');
    assert.ok(sendCalls[1].text.includes('Nearest available'), 'alternatives offered');
    let persisted = await waitFor(() => mongoState(PHONE_RSTAKEN), { label: 'rejected reschedule persisted' });
    assert.equal(String(persisted.slots.targetAppointmentId), String(apptOld._id), 'target stays pinned so the patient can pick an alternative');
    assert.equal(persisted.slots.date, undefined, 'the occupied new date is cleared so the flow re-asks');
    assert.equal(persisted.slots.time, undefined, 'the occupied new time is cleared so the flow re-asks');

    // Turn 3 picks a free slot → confirmation summary (validated and accepted).
    const result3 = await handleInbound(
      { phone: PHONE_RSTAKEN, text: 'kal 12 baje karo', waMessageId: 'wamid.tk.2' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );
    assert.equal(result3.state, 'AWAITING_CONFIRMATION');
    assert.ok(sendCalls[2].text.includes('Reschedule karein'));

    // Turn 4 confirms → the reschedule executes.
    const result4 = await handleInbound(
      { phone: PHONE_RSTAKEN, text: 'yes', waMessageId: 'wamid.tk.3' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );
    assert.equal(result4.state, 'IDLE');
    assert.ok(sendCalls[3].text.includes('Appointment rescheduled'));

    const oldDoc = await Appointment.findById(apptOld._id).lean();
    assert.equal(oldDoc.status, 'rescheduled', 'original moved only after a free slot was confirmed');
    const next = await Appointment.findOne({ rescheduledFrom: apptOld._id }).lean();
    assert.equal(next.date, tomorrow);
    assert.equal(next.time, '12:00');
    const occupierSlot = await Appointment.countDocuments({ doctorId: doctorConfig._id, date: tomorrow, time: '11:00', status: 'confirmed' });
    assert.equal(occupierSlot, 1, 'only the occupier holds the 11:00 slot');
  });
});
