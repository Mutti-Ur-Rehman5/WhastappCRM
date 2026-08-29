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
import { handleInbound } from '../../src/orchestrator/conversation.orchestrator.js';
import { todayInClinicTimeZone } from '../../src/utils/datetime.util.js';

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
  sendCalls.push({ to, text, channel: 'text', at: Date.now() });
  outboundSeq += 1;
  return `wamid.mixch.txt.${outboundSeq}`;
}

let voiceSendCalls = [];
let voiceSeq = 0;

async function mockSendVoiceMessage({ to, text }) {
  voiceSendCalls.push({ to, text, channel: 'voice', at: Date.now() });
  voiceSeq += 1;
  return `wamid.mixch.vox.${voiceSeq}`;
}

function scriptedNlu(map, { onCall } = {}) {
  return async ({ phone, history, slots, todayRef, state }) => {
    onCall?.({ phone, history, slots, todayRef, state });
    const latest = history.at(-1)?.text ?? '';
    return { toolCall: map(latest, { todayRef, state }) };
  };
}

async function mongoState(phone) {
  return Conversation.findOne({ phone }).lean();
}

const PHONE_MIX1 = '+923001234701';
const PHONE_MIX2 = '+923001234702';
const PHONE_MIX3 = '+923001234703';
const PHONE_MIX4 = '+923001234704';
const ALL_PHONES = [PHONE_MIX1, PHONE_MIX2, PHONE_MIX3, PHONE_MIX4];

let doctorConfig;

before(async () => {
  await connectTestDb();
  await Conversation.deleteMany({ phone: { $in: ALL_PHONES } });
  await AuditLog.deleteMany({});
  await MessageLog.deleteMany({});
  await Patient.deleteMany({ phone: { $in: ALL_PHONES } });
  await Appointment.deleteMany({ patientPhone: { $in: ALL_PHONES } });
  await DoctorConfig.deleteMany({ doctorName: 'mixed-channel.test.config' });
  doctorConfig = await DoctorConfig.create({
    doctorName: 'mixed-channel.test.config',
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
  sendCalls.length = 0;
  voiceSendCalls.length = 0;
  outboundSeq = 0;
  voiceSeq = 0;
});

after(async () => {
  await closeTestDb();
  await redis.quit();
});

describe('mixed-channel conversation (text+voice switching)', () => {
  it('(a) text start → voice name → text reason → correct booking with all fields', async () => {
    sendCalls.length = 0;
    voiceSendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();

    const nlu = scriptedNlu((text) => {
      if (text.startsWith('appointment book')) return { name: 'book_appointment', input: {} };
      if (text.startsWith('Ahmed voice')) return { name: 'book_appointment', input: { name: 'Ahmed Voice' } };
      if (text.includes('fever')) return { name: 'book_appointment', input: { reason: 'fever' } };
      if (text === 'yes') return { name: 'confirm', input: { value: true } };
      return { name: 'smalltalk_or_unclear', input: { replyHint: 'unexpected' } };
    });

    const r1 = await handleInbound(
      { phone: PHONE_MIX1, text: 'appointment book karni hai', waMessageId: 'wamid.mixch.a0' },
      { nlu, sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig },
    );
    assert.equal(r1.state, 'COLLECTING_NAME', 'T1: asks for name');
    assert.equal(sendCalls.length, 1, 'T1: text reply');

    const r2 = await handleInbound(
      { phone: PHONE_MIX1, media: { mimeType: 'audio/ogg', data: Buffer.from('fake-audio').toString('base64') }, waMessageId: 'wamid.mixch.a1' },
      { nlu: scriptedNlu(() => ({ name: 'book_appointment', input: { name: 'Ahmed Voice' } })), sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig },
    );
    assert.equal(r2.state, 'COLLECTING_REASON', 'T2: asks for reason after voice name');
    assert.equal(voiceSendCalls.length, 1, 'T2: voice reply (voice-in → voice-out)');
    assert.equal(sendCalls.length, 1, 'T2: no extra text sends');

    const r3 = await handleInbound(
      { phone: PHONE_MIX1, text: 'fever hai', waMessageId: 'wamid.mixch.a2' },
      { nlu, sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig },
    );
    assert.equal(r3.state, 'AWAITING_CONFIRMATION', 'T3: confirmation summary');
    assert.equal(sendCalls.length, 2, 'T3: text reply for confirmation');
    assert.ok(sendCalls[1].text.includes('Ahmed Voice'), 'T3: voice-provided name in summary');
    assert.ok(sendCalls[1].text.includes('fever'), 'T3: text-provided reason in summary');

    const r4 = await handleInbound(
      { phone: PHONE_MIX1, text: 'yes', waMessageId: 'wamid.mixch.a3' },
      { nlu, sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig },
    );
    assert.equal(r4.state, 'IDLE', 'T4: booked → IDLE');

    const final = await mongoState(PHONE_MIX1);
    assert.equal(final.state, 'IDLE');
    assert.equal(final.slots.name, undefined, 'slots cleared');

    const appt = await Appointment.findOne({ patientPhone: PHONE_MIX1 }).lean();
    assert.ok(appt, 'appointment created');
    assert.equal(appt.patientName, 'Ahmed Voice', 'appointment has voice-provided name');
    assert.equal(appt.reason, 'fever', 'appointment has text-provided reason');
  });

  it('(b) voice start → text decline → voice confirm with all details', async () => {
    sendCalls.length = 0;
    voiceSendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();

    const r1 = await handleInbound(
      { phone: PHONE_MIX2, media: { mimeType: 'audio/ogg', data: Buffer.from('fake-1').toString('base64') }, waMessageId: 'wamid.mixch.b0' },
      {
        nlu: async () => ({ toolCall: { name: 'book_appointment', input: { name: 'Sara', reason: 'checkup' } } }),
        sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig,
      },
    );
    assert.equal(r1.state, 'AWAITING_CONFIRMATION', 'T1: voice booking → confirmation');
    assert.equal(voiceSendCalls.length, 1, 'T1: voice reply');

    const r2 = await handleInbound(
      { phone: PHONE_MIX2, text: 'nahi', waMessageId: 'wamid.mixch.b1' },
      { nlu: scriptedNlu(() => ({ name: 'confirm', input: { value: false } })), sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig },
    );
    assert.equal(r2.state, 'IDLE', 'T2: decline → IDLE');
    assert.equal(sendCalls.length, 1, 'T2: text reply (text-in → text-out)');
    assert.ok(sendCalls[0].text.includes('no problem'), 'T2: polite closing');
    assert.equal(voiceSendCalls.length, 1, 'T2: no extra voice sends');

    const r3 = await handleInbound(
      { phone: PHONE_MIX2, media: { mimeType: 'audio/ogg', data: Buffer.from('fake-3').toString('base64') }, waMessageId: 'wamid.mixch.b2' },
      {
        nlu: async () => ({ toolCall: { name: 'book_appointment', input: { name: 'Sara', reason: 'checkup' } } }),
        sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig,
      },
    );
    assert.equal(r3.state, 'AWAITING_CONFIRMATION', 'T3: fresh booking → confirmation');
    assert.equal(voiceSendCalls.length, 2, 'T3: voice reply (voice-in → voice-out)');

    const final = await mongoState(PHONE_MIX2);
    assert.equal(final.state, 'AWAITING_CONFIRMATION', 'state is awaiting confirmation for fresh booking');
    assert.equal(final.pendingIntent, 'book', 'pendingIntent reset to book');
  });

  it('(c) voice booking request → typed "yes" confirmation', async () => {
    sendCalls.length = 0;
    voiceSendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();

    const nluVoiceFull = scriptedNlu(() => ({
      name: 'book_appointment',
      input: { name: 'Voice Confirm Patient', reason: 'headache' },
    }));

    const r1 = await handleInbound(
      { phone: PHONE_MIX3, media: { mimeType: 'audio/ogg', data: Buffer.from('fake-c1').toString('base64') }, waMessageId: 'wamid.mixch.c0' },
      { nlu: nluVoiceFull, sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig },
    );
    assert.equal(r1.state, 'AWAITING_CONFIRMATION', 'T1: voice booking → confirmation');
    assert.equal(voiceSendCalls.length, 1, 'T1: voice reply');
    assert.ok(voiceSendCalls[0].text.includes('Voice Confirm Patient'), 'T1: name in voice confirmation');

    const r2 = await handleInbound(
      { phone: PHONE_MIX3, text: 'yes', waMessageId: 'wamid.mixch.c1' },
      { nlu: scriptedNlu(() => ({ name: 'confirm', input: { value: true } })), sendMessage: mockSendMessage, sendVoiceMessage: mockSendVoiceMessage, todayRef, doctorConfig },
    );
    assert.equal(r2.state, 'IDLE', 'T2: typed "yes" confirms → IDLE');
    assert.equal(sendCalls.length, 1, 'T2: text reply (text-in → text-out)');
    assert.equal(voiceSendCalls.length, 1, 'T2: no extra voice sends');

    const appt = await Appointment.findOne({ patientPhone: PHONE_MIX3 }).lean();
    assert.ok(appt, 'appointment created');
    assert.equal(appt.patientName, 'Voice Confirm Patient', 'booking completed with voice-provided name');
    assert.equal(appt.reason, 'headache', 'booking completed with voice-provided reason');
  });

  it('(d) returning patient sends first voice note — saved name auto-filled', async () => {
    sendCalls.length = 0;
    voiceSendCalls.length = 0;
    const todayRef = todayInClinicTimeZone();

    await Patient.create({ name: 'Returning Text Patient', phone: PHONE_MIX4 });

    await Conversation.create({
      phone: PHONE_MIX4,
      state: 'IDLE',
      slots: { phone: PHONE_MIX4 },
      history: [
        { role: 'user', text: 'I want to book' },
        { role: 'assistant', text: 'Sure! Aapka naam kya hai?' },
        { role: 'user', text: 'Returning Text Patient' },
        { role: 'assistant', text: 'Confirm karein?' },
        { role: 'user', text: 'yes' },
        { role: 'assistant', text: 'Appointment confirmed.' },
      ],
    });

    const r2 = await handleInbound(
      { phone: PHONE_MIX4, media: { mimeType: 'audio/ogg', data: Buffer.from('fake-d2').toString('base64') }, waMessageId: 'wamid.mixch.d0' },
      {
        nlu: async () => ({
          toolCall: { name: 'book_appointment', input: { reason: 'checkup' } },
        }),
        sendMessage: mockSendMessage,
        sendVoiceMessage: mockSendVoiceMessage,
        todayRef,
        doctorConfig,
      },
    );

    assert.equal(r2.state, 'AWAITING_CONFIRMATION', 'T2: auto-filled name → confirmation');
    assert.equal(voiceSendCalls.length, 1, 'T2: voice reply (voice-in → voice-out)');

    const final = await mongoState(PHONE_MIX4);
    assert.equal(final.slots.name, 'Returning Text Patient', 'saved name auto-filled on first voice note');
    assert.equal(final.slots.reason, 'checkup', 'reason from voice transcript');
    assert.ok(final.slots.date, 'date auto-assigned');
    assert.ok(final.slots.time, 'time auto-assigned');
  });
});
