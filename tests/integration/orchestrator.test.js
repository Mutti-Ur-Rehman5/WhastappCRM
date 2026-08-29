import { describe, it, before, after } from 'node:test';
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
import {
  handleInbound,
  NLU_FALLBACK_REPLY,
  VOICE_UNCLEAR_REPLY,
  VOICE_GUIDED_REPLY,
} from '../../src/orchestrator/conversation.orchestrator.js';
import { buildSheetRow } from '../../src/services/sheets.service.js';
import { todayInClinicTimeZone, toUtcInstant } from '../../src/utils/datetime.util.js';

// ----------------------------------------------------------------- helpers ---

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
  return `wamid.out.orch.${outboundSeq}`;
}

let voiceSendCalls = [];
let voiceSeq = 0;

async function mockSendVoiceMessage({ to, text }) {
  voiceSendCalls.push({ to, text, at: Date.now() });
  voiceSeq += 1;
  return `wamid.out.orch.voice.${voiceSeq}`;
}

// Scripted NLU: chooses the canned tool call by the LATEST user turn. It is
// handed todayRef by the orchestrator (server-injected) and resolves relative
// dates against it — exactly what the real Gemini call will do, so the test
// proves the pipeline, not the model.
function scriptedNlu(map, { onCall } = {}) {
  return async ({ phone, history, slots, todayRef }) => {
    onCall?.({ phone, history, slots, todayRef });
    const latest = history.at(-1)?.text ?? '';
    return { toolCall: map(latest, { todayRef }) };
  };
}

async function mongoState(phone) {
  return Conversation.findOne({ phone }).lean();
}

// ------------------------------------------------------------------ setup ---

const PHONE_EN = '+923001234601';
const PHONE_RU = '+923001234602';
const PHONE_IDEMP = '+923001234603';
const PHONE_FALLBACK = '+923001234604';
const PHONE_VOICE = '+923001234607';
const PHONE_Q = '+923001234605';
const PHONE_REUSE = '+923001234606';
const PHONE_ONESHOT = '+923001234608';
const PHONE_VOICENAME = '+923001234609';
const PHONE_VOICENEW = '+923001234610';
const ALL_PHONES = [PHONE_EN, PHONE_RU, PHONE_IDEMP, PHONE_FALLBACK, PHONE_VOICE, PHONE_Q, PHONE_REUSE, PHONE_ONESHOT, PHONE_VOICENAME, PHONE_VOICENEW];

// Phase 4: confirming a booking now runs the REAL locked transaction
// (booking.service.js), so this file seeds its own DoctorConfig and cleans the
// Appointment/Patient rows its confirm turns create. doctorName is unique to
// this file so it never collides with the other integration suites that share
// the same local Mongo/Redis.
let doctorConfig;

before(async () => {
  await connectTestDb();
  await Conversation.deleteMany({ phone: { $in: ALL_PHONES } });
  await AuditLog.deleteMany({});
  await MessageLog.deleteMany({ phone: { $in: ALL_PHONES } });
  await Patient.deleteMany({ phone: { $in: ALL_PHONES } });
  await Appointment.deleteMany({ patientPhone: { $in: ALL_PHONES } });
  await DoctorConfig.deleteMany({ doctorName: 'orchestrator.test.config' });
  doctorConfig = await DoctorConfig.create({
    doctorName: 'orchestrator.test.config',
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
  await Promise.all(ALL_PHONES.map((p) => redis.del(convKey(p))));
  await invalidateDoctorConfigCache();
});

after(async () => {
  await closeTestDb();
  // Quit the shared ioredis client so the test process exits cleanly.
  await redis.quit();
});

// ------------------------------------------------------------------ tests ---

describe('conversation orchestrator (multi-turn booking, mocked NLU)', () => {
  it('collects name → reason → auto-assigns datetime and reaches AWAITING_CONFIRMATION, then confirms to IDLE', async () => {
    const todayRef = todayInClinicTimeZone();
    const tomorrow = dayjs(todayRef).add(1, 'day').format('YYYY-MM-DD');

    const nlu = scriptedNlu((text) => {
      if (text.startsWith('I want to book')) return { name: 'book_appointment', input: { date: tomorrow } };
      if (text.startsWith('My name is')) return { name: 'book_appointment', input: { name: 'Ahmed Raza' } };
      if (text.startsWith('I have a fever')) return { name: 'book_appointment', input: { reason: 'fever' } };
      if (text === 'yes') return { name: 'confirm', input: { value: true } };
      return { name: 'smalltalk_or_unclear', input: { replyHint: 'unexpected' } };
    });

    const turns = [
      ['I want to book an appointment for tomorrow', 'COLLECTING_NAME'],
      ['My name is Ahmed Raza', 'COLLECTING_REASON'],
      ['I have a fever', 'AWAITING_CONFIRMATION'],
      ['yes', 'IDLE'],
    ];

    for (let i = 0; i < turns.length; i += 1) {
      const [text, expectedState] = turns[i];
      const result = await handleInbound({ phone: PHONE_EN, text, waMessageId: `wamid.en.${i}` }, { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig });
      assert.equal(result.state, expectedState, `turn ${i + 1} state`);
      const persisted = await waitFor(() => mongoState(PHONE_EN), { label: `persisted state after turn ${i + 1}` });
      assert.equal(persisted.state, expectedState, `turn ${i + 1} persisted state`);

      if (i === 2) {
        // Auto-assign: name + reason present → time auto-assigned → AWAITING_CONFIRMATION.
        assert.ok(persisted.slots.date, 'date auto-filled');
        assert.ok(persisted.slots.time, 'time auto-filled via findAutoSlot');
        assert.equal(persisted.slots.name, 'Ahmed Raza');
        assert.equal(persisted.slots.reason, 'fever');
        assert.ok(sendCalls[2].text.includes('Confirm karein'));
      }
    }

    // After the confirm turn, MEMORY §5: state IDLE + slots cleared.
    const final = await mongoState(PHONE_EN);
    assert.equal(final.state, 'IDLE');
    assert.equal(final.slots.date, undefined, 'slots cleared after conclusion');
    assert.equal(final.slots.name, undefined, 'slots cleared after conclusion');

    // Each turn produced one WhatsApp reply.
    assert.equal(sendCalls.length, 4);
    assert.ok(sendCalls.every((c) => c.to === PHONE_EN));
  });

  it('handles Roman Urdu input end-to-end ("kal shaam 4 baje") using the server-injected todayRef', async () => {
    const todayRef = todayInClinicTimeZone();
    const tomorrow = dayjs(todayRef).add(1, 'day').format('YYYY-MM-DD');

    const nlu = scriptedNlu((text) => {
      if (text.includes('kal shaam')) return { name: 'book_appointment', input: { date: tomorrow, time: '16:00' } };
      if (text.includes('naam')) return { name: 'book_appointment', input: { name: 'Ahmed Raza' } };
      if (text.includes('wajah')) return { name: 'book_appointment', input: { reason: 'fever' } };
      if (text.includes('theek hai')) return { name: 'book_appointment', input: {} };
      if (text.includes('confirm karo')) return { name: 'confirm', input: { value: true } };
      return { name: 'smalltalk_or_unclear', input: { replyHint: 'unexpected' } };
    });

    const turns = [
      ['kal shaam 4 baje appointment chahiye', 'COLLECTING_NAME'],
      ['mera naam Ahmed Raza hai', 'COLLECTING_REASON'],
      ['fever ki wajah se aana hai', 'AWAITING_CONFIRMATION'],
      ['theek hai, book kar do', 'AWAITING_CONFIRMATION'],
      ['haan confirm karo', 'IDLE'],
    ];

    for (let i = 0; i < turns.length; i += 1) {
      const [text, expectedState] = turns[i];
      const result = await handleInbound({ phone: PHONE_RU, text, waMessageId: `wamid.ru.${i}` }, { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig });
      assert.equal(result.state, expectedState, `RU turn ${i + 1} state`);
      const persisted = await waitFor(() => mongoState(PHONE_RU), { label: `persisted RU state after turn ${i + 1}` });
      assert.equal(persisted.state, expectedState, `RU turn ${i + 1} persisted state`);

      // date/time came from turn 1 ("kal shaam 4 baje" = tomorrow 16:00 via
      // the server-injected todayRef); name/reason from turns 2–3.
      if (i === 2) {
        assert.equal(persisted.slots.date, tomorrow, 'RU relative date resolved against todayRef');
        assert.equal(persisted.slots.time, '16:00', 'RU fuzzy time resolved to 16:00');
        assert.equal(persisted.slots.name, 'Ahmed Raza');
        assert.equal(persisted.slots.reason, 'fever');
      }
    }

    const final = await mongoState(PHONE_RU);
    // The resolved date is todayRef+1 — proving the SERVER injected todayRef and
    // the mock (standing in for the model) used it, not its own calendar.
    assert.equal(final.slots.date, undefined, 'slots cleared after confirm');
    const audits = await AuditLog.find({ entity: 'conversation', entityId: final._id }).lean();
    assert.ok(audits.some((a) => a.action === 'state:COLLECTING_REASON->AWAITING_CONFIRMATION'));
    assert.equal(sendCalls.length, 9, 'RU flow also produced one reply per turn');
  });

  it('always injects the server-side todayRef into every NLU call', async () => {
    const seen = [];
    const todayRef = todayInClinicTimeZone();
    const nlu = scriptedNlu(
      (text) => {
        if (text.includes('kal')) return { name: 'book_appointment', input: { date: dayjs(todayRef).add(1, 'day').format('YYYY-MM-DD') } };
        return { name: 'smalltalk_or_unclear', input: { replyHint: 'ok' } };
      },
      { onCall: ({ todayRef: injected }) => seen.push(injected) },
    );

    await handleInbound(
      { phone: PHONE_EN, text: 'kal appointment chahiye', waMessageId: 'wamid.todayref.1' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );
    await handleInbound(
      { phone: PHONE_EN, text: 'thanks', waMessageId: 'wamid.todayref.2' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );

    assert.ok(seen.length >= 1, 'NLU was called');
    for (const injected of seen) {
      assert.equal(injected, todayRef, 'todayRef is server-computed and identical on every call');
      assert.match(injected, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('is idempotent: a redelivered waMessageId never double-sends or double-advances', async () => {
    const todayRef = todayInClinicTimeZone();
    const nlu = scriptedNlu(() => ({ name: 'book_appointment', input: { name: 'Ayesha' } }));

    const first = await handleInbound(
      { phone: PHONE_IDEMP, text: 'I want to book', waMessageId: 'wamid.idemp.1' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );
    const second = await handleInbound(
      { phone: PHONE_IDEMP, text: 'I want to book', waMessageId: 'wamid.idemp.1' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );

    assert.equal(second.duplicate, true);
    assert.equal(second.reply, null);
    assert.equal(first.state, 'COLLECTING_REASON');
    assert.equal(second.state, null);

    const sent = sendCalls.filter((c) => c.to === PHONE_IDEMP);
    assert.equal(sent.length, 1, 'exactly one reply for the whole job lifecycle');

    const final = await mongoState(PHONE_IDEMP);
    assert.equal(final.history.filter((h) => h.role === 'user').length, 1, 'user turn not duplicated');
    assert.equal(final.slots.name, 'Ayesha');
  });

  it('a voice note the model cannot parse gets the voice-specific guided reply, not the generic text phrasing', async () => {
    voiceSendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();
    const nlu = async () => ({
      toolCall: { name: 'smalltalk_or_unclear', input: { replyHint: NLU_FALLBACK_REPLY } },
      transcript: 'yar samajh nahi aya',
    });

    const result = await handleInbound(
      {
        phone: PHONE_VOICE,
        media: { mimeType: 'audio/ogg', data: Buffer.from('fake-audio').toString('base64') },
        waMessageId: 'wamid.voice.1',
      },
      { nlu, sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig },
    );

    assert.equal(result.reply, VOICE_GUIDED_REPLY);
    assert.equal(result.state, 'IDLE');
    const textSent = sendCalls.filter((c) => c.to === PHONE_VOICE);
    assert.equal(textSent.length, 0, 'a voice-in turn must not fall through to the text path');
    const voiceSent = voiceSendCalls.filter((c) => c.to === PHONE_VOICE);
    assert.equal(voiceSent.length, 1);
    assert.equal(voiceSent[0].text, VOICE_GUIDED_REPLY);
    // The turn history records the TRANSCRIPT, never the audio bytes and never
    // the transient "[voice note]" marker.
    const conv = await mongoState(PHONE_VOICE);
    const lastUserTurn = [...conv.history].reverse().find((h) => h.role === 'user');
    assert.equal(lastUserTurn.text, 'yar samajh nahi aya');
  });

  it('a voice turn with NO transcript (transcription failed) keeps the marker out of slots — the name is re-asked, never set to "[voice note]"', async () => {
    voiceSendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();
    const nlu = async () => ({
      toolCall: { name: 'smalltalk_or_unclear', input: { replyHint: NLU_FALLBACK_REPLY } },
      transcript: undefined,
    });

    const result = await handleInbound(
      {
        phone: PHONE_VOICE,
        media: { mimeType: 'audio/ogg', data: Buffer.from('fake-audio').toString('base64') },
        waMessageId: 'wamid.voice.2',
      },
      { nlu, sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig },
    );

    assert.equal(result.reply, VOICE_GUIDED_REPLY);
    const conv = await mongoState(PHONE_VOICE);
    assert.equal(conv.slots.name, undefined, 'the marker must never leak into slots');
    const voiceSent = voiceSendCalls.filter((c) => c.to === PHONE_VOICE);
    assert.equal(voiceSent.length, 1, 'voice reply went through the voice channel');
  });

  it('falls back to a friendly reply when NLU fails (DESIGN.md §10) instead of crashing', async () => {
    const todayRef = todayInClinicTimeZone();
    const failingNlu = async () => {
      throw new Error('upstream timeout');
    };

    const result = await handleInbound(
      { phone: PHONE_FALLBACK, text: 'hello??', waMessageId: 'wamid.fb.1' },
      { nlu: failingNlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );

    assert.equal(result.reply, NLU_FALLBACK_REPLY);
    assert.equal(result.state, 'IDLE');
    const sent = sendCalls.filter((c) => c.to === PHONE_FALLBACK);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, NLU_FALLBACK_REPLY);
  });

  it('"doctor ka schedule bta do" → the weekly schedule card, no state change', async () => {
    sendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();
    const nlu = scriptedNlu(() => ({ name: 'check_availability', input: {} }));

    const result = await handleInbound(
      { phone: PHONE_Q, text: 'doctor ka schedule bta do', waMessageId: 'wamid.q.sched' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );

    assert.equal(result.state, 'IDLE', 'query answers directly without a state change');
    assert.ok(sendCalls[0].text.includes('Clinic hours'), 'schedule card headline');
    assert.ok(sendCalls[0].text.includes('Monday: 09:00'), 'weekday hours listed');
    assert.ok(sendCalls[0].text.includes('Closed / Band'), 'closed day shown');
  });

  it('check_availability with a date → that day\'s free slots (buffer-aware grid)', async () => {
    sendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();
    // Pick a future WORKING day (the seeded config closes Sundays) so the grid
    // assertions never land on a closed weekday and become date-rollover flaky.
    let probe = dayjs(todayRef).add(2, 'day');
    while (probe.day() === 0) probe = probe.add(1, 'day');
    const freeDate = probe.format('YYYY-MM-DD');
    const nlu = scriptedNlu(() => ({ name: 'check_availability', input: { date: freeDate } }));

    const result = await handleInbound(
      { phone: PHONE_Q, text: 'kal kya time free hai?', waMessageId: 'wamid.q.slots' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );

    assert.equal(result.state, 'IDLE');
    assert.ok(sendCalls[0].text.includes(freeDate), 'replies for the asked date');
    assert.ok(sendCalls[0].text.includes('09:00'), 'first grid slot shown');
    assert.ok(sendCalls[0].text.includes('09:20'), 'buffer-strided grid (15min + 5min buffer)');
    assert.ok(!sendCalls[0].text.includes('13:00'), 'lunch-break slot is not offered');
  });

  it('query_my_appointments → lists the patient\'s upcoming appointments', async () => {
    sendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();
    const tomorrow = dayjs(todayRef).add(1, 'day').format('YYYY-MM-DD');
    const patient = await Patient.create({ name: 'Query Patient', phone: PHONE_Q });
    const appt = await Appointment.create({
      tokenNo: 778899,
      doctorId: doctorConfig._id,
      patientId: patient._id,
      patientName: patient.name,
      patientPhone: patient.phone,
      date: tomorrow,
      time: '11:00',
      slotStart: toUtcInstant(tomorrow, '11:00'),
      reason: 'checkup',
      status: 'confirmed',
    });

    const nlu = scriptedNlu(() => ({ name: 'query_my_appointments', input: {} }));
    const result = await handleInbound(
      { phone: PHONE_Q, text: 'mera appointment kab hai?', waMessageId: 'wamid.q.mine' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );

    assert.equal(result.state, 'IDLE');
    assert.ok(sendCalls[0].text.includes('upcoming appointments'));
    assert.ok(sendCalls[0].text.includes(`${tomorrow} at 11:00`), 'the appointment is listed');
    assert.ok(sendCalls[0].text.includes(`Token #${appt.tokenNo}`), 'token number included');
  });

  it('a returning patient is never asked for the phone OR the stored name again — and a newly spoken name still wins', async () => {
    sendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();
    const tomorrow = dayjs(todayRef).add(1, 'day').format('YYYY-MM-DD');
    // The patient already exists under their previous booking's name (history).
    await Patient.create({ name: 'Mutti Ur Rehman', phone: PHONE_REUSE });

    const nlu = scriptedNlu((text) => {
      if (text.includes('book karna')) return { name: 'book_appointment', input: { date: tomorrow, time: '10:20' } };
      if (text.includes('naam')) return { name: 'book_appointment', input: { name: 'Abdul Rahman' } };
      if (text.includes('fever')) return { name: 'book_appointment', input: { reason: 'fever' } };
      if (text === 'yes') return { name: 'confirm', input: { value: true } };
      return { name: 'smalltalk_or_unclear', input: { replyHint: 'unexpected' } };
    });

    const turns = [
      // Turn 0 carries date+time only. The stored name is REUSED from history,
      // so the flow jumps straight past COLLECTING_NAME to the reason question.
      ['I want to book karna', 'COLLECTING_REASON'],
      // The patient still says a name — that new name wins over the stored one.
      ['mera naam Abdul Rahman hai', 'COLLECTING_REASON'],
      ['fever ki wajah', 'AWAITING_CONFIRMATION'],
      ['yes', 'IDLE'],
    ];

    for (let i = 0; i < turns.length; i += 1) {
      const [text, expectedState] = turns[i];
      const result = await handleInbound({ phone: PHONE_REUSE, text, waMessageId: `wamid.reuse.${i}` }, { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig });
      assert.equal(result.state, expectedState, `reuse turn ${i + 1} state`);
      // The pre-seeded sender phone must never be asked for again (MEMORY.md §2).
      assert.ok(!sendCalls[i].text.includes('phone number'), `turn ${i + 1} does not ask for the phone`);
      if (i === 0) {
        // The stored name from previous history is reused — not re-asked.
        assert.ok(!sendCalls[i].text.includes('naam'), 'turn 1 does not re-ask for the stored name');
        assert.ok(sendCalls[i].text.includes('wajah'), 'turn 1 asks for the reason');
      }
    }

    // The phone survives slot-clearing so the NEXT booking starts from a clean slate.
    const persisted = await mongoState(PHONE_REUSE);
    assert.equal(persisted.slots.phone, PHONE_REUSE, 'phone is re-seeded after the booking concludes');

    // The NEW name from chat — not the first-ever name — lands on the
    // appointment and therefore the Google Sheet mirror.
    const [appt] = await Appointment.find({ patientPhone: PHONE_REUSE }).sort({ createdAt: -1 }).limit(1).lean();
    assert.equal(appt.patientName, 'Abdul Rahman', 'appointment uses the chat-provided name');
    assert.equal(buildSheetRow(appt)[1], 'Abdul Rahman', 'sheet row shows the chat-provided name');
    const updated = await Patient.findOne({ phone: PHONE_REUSE }).lean();
    assert.equal(updated.name, 'Abdul Rahman', 'stored patient name is refreshed to the latest');
  });

  // BUG-2 regression: a SINGLE message with ALL required fields must complete
  // the booking in one turn (straight to the confirm summary) — not get stuck
  // asking for each field or bounce a generic fallback.
  it('one message with name + reason + date + time jumps straight to the confirmation summary (one-shot booking)', async () => {
    sendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();
    // Pick a future WORKING day (the seeded config closes Sundays) so the
    // confirmation is reached instead of a closed-day guard.
    let probe = dayjs(todayRef).add(1, 'day');
    while (probe.day() === 0) probe = probe.add(1, 'day');
    const tomorrow = probe.format('YYYY-MM-DD');
    const nlu = scriptedNlu(() => ({
      name: 'book_appointment',
      input: { name: 'Sana Khan', reason: 'fever', date: tomorrow, time: '15:30' },
    }));

    const result = await handleInbound(
      { phone: PHONE_ONESHOT, text: 'mera naam Sana Khan hai, fever hai, kal 11 baje aana hai', waMessageId: 'wamid.oneshot.1' },
      { nlu, sendMessage: mockSendMessage, todayRef, doctorConfig },
    );

    assert.equal(result.state, 'AWAITING_CONFIRMATION', 'one-shot goes straight to confirmation');
    assert.ok(sendCalls[0].text.includes('Confirm karein'), 'confirmation summary shown');
    assert.ok(sendCalls[0].text.includes('Sana Khan'), 'name present in summary');
    assert.ok(sendCalls[0].text.includes('fever'), 'reason present in summary');
    const persisted = await mongoState(PHONE_ONESHOT);
    assert.deepEqual(
      {
        name: persisted.slots.name,
        reason: persisted.slots.reason,
        date: persisted.slots.date,
        time: persisted.slots.time,
      },
      { name: 'Sana Khan', reason: 'fever', date: tomorrow, time: '15:30' },
      'all fields landed in slots in one turn',
    );
  });

  // BUG-1 regression: the transient "[voice note]" marker must NEVER become the
  // booking Name. When the NLU echoes it as a name value, the orchestrator
  // treats it as missing — a returning patient's stored name is reused instead.
  it('a voice note whose NLU returns the "[voice note]" marker as name falls back to the stored name (never books a placeholder)', async () => {
    voiceSendCalls.length = 0;
    sendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();
    let probe = dayjs(todayRef).add(1, 'day');
    while (probe.day() === 0) probe = probe.add(1, 'day');
    const tomorrow = probe.format('YYYY-MM-DD');
    // Returning patient: stored name exists in history.
    await Patient.create({ name: 'Stored Patient', phone: PHONE_VOICENAME });

    // The scripted NLU deliberately returns the marker as the name — the
    // failure mode that used to produce "Name: [voice note]" bookings.
    const nlu = scriptedNlu(() => ({
      name: 'book_appointment',
      input: { name: '[voice note]', reason: 'fever', date: tomorrow, time: '15:30' },
    }));

    const result = await handleInbound(
      { phone: PHONE_VOICENAME, media: { mimeType: 'audio/ogg', data: Buffer.from('fake-audio').toString('base64') }, waMessageId: 'wamid.vname.1' },
      { nlu, sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig },
    );

    assert.equal(result.state, 'AWAITING_CONFIRMATION', 'name is not re-asked for a returning patient');
    const persisted = await mongoState(PHONE_VOICENAME);
    assert.notEqual(persisted.slots.name, '[voice note]', 'the marker never lands in slots.name');
    assert.equal(persisted.slots.name, 'Stored Patient', 'the stored name is reused instead');
  });

  // BUG-1 companion: for a FIRST-TIME patient, a marker-as-name is treated as
  // missing, so the flow asks for a real name instead of booking a placeholder.
  it('a first-time patient whose voice NLU returns "[voice note]" as name gets asked for their real name', async () => {
    voiceSendCalls.length = 0;
    sendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();
    let probe = dayjs(todayRef).add(1, 'day');
    while (probe.day() === 0) probe = probe.add(1, 'day');
    const tomorrow = probe.format('YYYY-MM-DD');
    const nlu = scriptedNlu(() => ({
      name: 'book_appointment',
      input: { name: '[voice note]', date: tomorrow, time: '11:00' },
    }));

    const result = await handleInbound(
      { phone: PHONE_VOICENEW, media: { mimeType: 'audio/ogg', data: Buffer.from('fake-audio').toString('base64') }, waMessageId: 'wamid.vname.2' },
      { nlu, sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig },
    );

    assert.equal(result.state, 'COLLECTING_NAME', 'asks for the name instead of booking a placeholder');
    const persisted = await mongoState(PHONE_VOICENEW);
    assert.notEqual(persisted.slots.name, '[voice note]', 'the marker never lands in slots.name');
  });
});

