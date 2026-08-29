import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { redis } from '../../src/config/redis.js';
import { DoctorConfig, WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import { Patient } from '../../src/models/Patient.model.js';
import { Appointment } from '../../src/models/Appointment.model.js';
import { AuditLog } from '../../src/models/AuditLog.model.js';
import { MessageLog } from '../../src/models/MessageLog.model.js';
import { toUtcInstant } from '../../src/utils/datetime.util.js';
import { invalidateDoctorConfigCache } from '../../src/services/slot.service.js';
import {
  requestRescheduleConfirmation,
  confirmReschedule,
  declineReschedule,
  expireReschedule,
  parseRescheduleButtonId,
} from '../../src/services/rescheduleConfirmation.service.js';
import { sendInteractiveButtons } from '../../src/services/whatsapp.service.js';
import { bookAppointment, checkSlotBookable } from '../../src/services/booking.service.js';
import { findNearestAvailable } from '../../src/services/suggestion.service.js';
import { pendingRescheduleKey } from '../../src/services/pendingReschedule.marker.js';
import { handleIncomingMessage, _setRescheduleDeps } from '../../src/webhooks/whatsapp.webhook.js';
import { rescheduleAlreadyHandled } from '../../src/prompts/templates.js';
import { SlotTakenError } from '../../src/utils/errors.js';

// PHASES.md Phase 12 — doctor-initiated reschedule with patient Yes/No
// confirmation. Five scenarios, exercised over real Mongo (replica set) +
// Redis (the marker is a real ioredis key):
//   1. the interactive buttons payload is built per the Meta Cloud API spec;
//   2. YES commits the move (new row, old rescheduled, marker released);
//   3. NO reverts (appointment untouched, marker released, stale taps idempotent);
//   4. timeout reverts and is safe (not_yet_expired guard, idempotent reruns);
//   5. the reserved slot blocks new bookings/suggestions and a YES/NO race
//      settles to a consistent DB.
// External sends and queue enqueues are injected mocks (RULES.md §7).

const DOCTOR_NAME = 'reschedule.confirmation.test.config';
const DAY = '2099-09-02'; // wednesday, working day (sunday disabled)

const RUN_DIGITS = Date.now().toString().slice(-8);
const marker = (doctorId, date, time) => pendingRescheduleKey(doctorId, date, time);

let config;
let patient; // primary patient — the one whose appointment gets proposed
let otherPatient; // attempts to book the reserved slot
let outbound = [];
let buttonSends = [];
let sheetSyncs = [];
let notifyDoctors = [];
let reminders = [];
let removedReminders = [];
let timeoutJobs = [];
let removedTimeouts = [];
const cleaned = { appointments: [], patients: [], audits: [], markers: [] };

// Always-increasing outbound-id counters (independent of the array resets
// between scenarios). waMessageIds carry a run-unique prefix so they can never
// collide with the MessageLog unique index across runs/suites.
let outboundSeq = 0;
let buttonSeq = 0;

const testDeps = {
  sendTextMessage: async ({ to, text }) => {
    outbound.push({ to, text });
    outboundSeq += 1;
    return `wamid.rs.${RUN_DIGITS}.out.${outboundSeq}`;
  },
  sendInteractiveButtons: async ({ to, body, buttons }) => {
    buttonSends.push({ to, body, buttons });
    buttonSeq += 1;
    return `wamid.rs.${RUN_DIGITS}.btn.${buttonSeq}`;
  },
  enqueueSheetSync: async (p) => sheetSyncs.push(p),
  enqueueNotifyDoctor: async (p) => notifyDoctors.push(p),
  enqueueScheduleReminders: async (p) => reminders.push(p),
  removeReminderJobs: async (p) => {
    removedReminders.push(p);
    return { removed: 0 };
  },
  enqueueRescheduleTimeout: async (p) => timeoutJobs.push(p),
  removeRescheduleTimeoutJob: async (token) => removedTimeouts.push(token),
};

const resStub = () => ({ status: () => ({ json: () => ({ ok: true }) }) });

function webhookButtonReply({ phone, buttonId, waMessageId }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'test-ba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '1' },
              messages: [
                {
                  from: phone,
                  id: waMessageId,
                  timestamp: '1700000000',
                  type: 'interactive',
                  interactive: {
                    type: 'button_reply',
                    button_reply: { id: buttonId, title: 'Yes' },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function createAppointment({ tokenNo, date = DAY, time }) {
  const appointment = await Appointment.create({
    tokenNo,
    doctorId: config._id,
    patientId: patient._id,
    patientName: patient.name,
    patientPhone: patient.phone,
    date,
    time,
    slotStart: toUtcInstant(date, time),
    status: 'confirmed',
  });
  cleaned.appointments.push(appointment._id.toString());
  return appointment;
}

async function propose({ appointmentId, newDate = DAY, newTime, confirmationTimeoutMs = 60_000 }) {
  return requestRescheduleConfirmation(
    { appointmentId, newDate, newTime, actor: 'admin' },
    { ...testDeps, confirmationTimeoutMs },
  );
}

before(async () => {
  await connectTestDb();
  await DoctorConfig.deleteMany({ doctorName: DOCTOR_NAME });
  await invalidateDoctorConfigCache();
  config = await DoctorConfig.create({
    doctorName: DOCTOR_NAME,
    doctorPhone: '+923001239991',
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
  patient = await Patient.create({ name: 'Confirm User', phone: '+923007777771' });
  otherPatient = await Patient.create({ name: 'Other User', phone: '+923007777772' });
  cleaned.patients.push(patient._id.toString(), otherPatient._id.toString());

  _setRescheduleDeps({
    confirmReschedule: (token, opts) => confirmReschedule(token, { ...testDeps, ...opts }),
    declineReschedule: (token, opts) => declineReschedule(token, { ...testDeps, ...opts }),
    sendTextMessage: testDeps.sendTextMessage,
  });
});

after(async () => {
  _setRescheduleDeps({});
  for (const key of cleaned.markers) await redis.del(key);
  await MessageLog.deleteMany({ phone: { $in: [patient.phone, otherPatient.phone, config.doctorPhone] } });
  await AuditLog.deleteMany({ entityId: { $in: cleaned.appointments } });
  await Appointment.deleteMany({ _id: { $in: cleaned.appointments } });
  await Patient.deleteMany({ _id: { $in: cleaned.patients } });
  await DoctorConfig.deleteMany({ doctorName: DOCTOR_NAME });
  await invalidateDoctorConfigCache();
  await closeTestDb();
  await redis.quit();
});

describe('reschedule confirmation (Phase 12)', () => {
  it('scenario 1 — sends a spec-compliant interactive YES/NO message and reserves the slot', async () => {
    const appt = await createAppointment({ tokenNo: 4001, time: '10:00' });

    const { appointment, pendingReschedule } = await propose({
      appointmentId: appt._id,
      newTime: '11:00',
    });
    const token = pendingReschedule.token;
    assert.match(token, /^[0-9a-f]{32}$/, 'opaque token');

    // Meta payload built by the REAL sendInteractiveButtons (mock http only).
    const httpCalls = [];
    const fakeHttp = {
      post: async (url, data) => {
        httpCalls.push({ url, data });
        return { data: { messages: [{ id: 'wamid.btn.meta.1' }] } };
      },
    };
    const waId = await sendInteractiveButtons({
      to: patient.phone,
      body: 'proposal body',
      buttons: [
        { id: `RS_YES_${token}`, title: 'Yes' },
        { id: `RS_NO_${token}`, title: 'No' },
      ],
      http: fakeHttp,
    });
    assert.equal(waId, 'wamid.btn.meta.1');
    assert.equal(httpCalls.length, 1);
    const payload = httpCalls[0].data;
    assert.equal(payload.messaging_product, 'whatsapp');
    assert.equal(payload.type, 'interactive');
    assert.equal(payload.interactive.type, 'button');
    assert.equal(payload.interactive.body.text, 'proposal body');
    assert.deepEqual(payload.interactive.action.buttons, [
      { type: 'reply', reply: { id: `RS_YES_${token}`, title: 'Yes' } },
      { type: 'reply', reply: { id: `RS_NO_${token}`, title: 'No' } },
    ]);

    // parseRescheduleButtonId round-trips both button ids.
    assert.deepEqual(parseRescheduleButtonId(`RS_YES_${token}`), { answer: 'yes', token });
    assert.deepEqual(parseRescheduleButtonId(`RS_NO_${token}`), { answer: 'no', token });
    assert.equal(parseRescheduleButtonId('SOME_OTHER_BUTTON'), null);

    // Proposal sent once through the injectable sender + MessageLog.
    assert.equal(buttonSends.length, 1);
    assert.equal(buttonSends[0].to, patient.phone);
    assert.match(buttonSends[0].body, /2099-09-02 at 11:00/);
    const proposalLog = await MessageLog.findOne({ phone: patient.phone, direction: 'out', body: buttonSends[0].body }).lean();
    assert.ok(proposalLog, 'proposal recorded in MessageLog');
    cleaned.audits.push(...(await AuditLog.find({ entityId: appt._id }).lean()).map((a) => a._id.toString()));

    // Timeout job scheduled (post-commit, best-effort).
    assert.equal(timeoutJobs.length, 1);
    assert.equal(timeoutJobs[0].token, token);
    assert.ok(timeoutJobs[0].delayMs >= 60_000);

    // Redis reservation + persisted pending state.
    const key = marker(config._id, DAY, '11:00');
    cleaned.markers.push(key);
    assert.equal(await redis.get(key), String(appt._id), 'slot reserved for the requesting appointment');
    const row = await Appointment.findById(appt._id).lean();
    assert.equal(row.status, 'confirmed');
    assert.equal(row.pendingReschedule.newTime, '11:00');
    assert.equal(String(row.pendingReschedule.token), token);
    assert.ok(row.pendingReschedule.requestedAt instanceof Date);
    assert.ok(row.pendingReschedule.expiresAt > row.pendingReschedule.requestedAt);
  });

  it('scenario 2 — YES commits the reschedule via the webhook button_reply', async () => {
    outbound = [];
    buttonSends = [];
    sheetSyncs = [];
    notifyDoctors = [];
    reminders = [];
    removedReminders = [];
    timeoutJobs = [];
    removedTimeouts = [];

    const appt = await createAppointment({ tokenNo: 4002, time: '09:00' });
    const { pendingReschedule } = await propose({ appointmentId: appt._id, newTime: '12:00' });
    const token = pendingReschedule.token;
    const key = marker(config._id, DAY, '12:00');
    cleaned.markers.push(key);
    const wamid = `wamid.in.yes.${RUN_DIGITS}`;

    await handleIncomingMessage(
      { body: webhookButtonReply({ phone: patient.phone, buttonId: `RS_YES_${token}`, waMessageId: wamid }), id: `corr.${RUN_DIGITS}` },
      resStub(),
    );

    const oldRow = await Appointment.findById(appt._id).lean();
    assert.equal(oldRow.status, 'rescheduled', 'old appointment marked rescheduled');
    assert.equal(oldRow.pendingReschedule, undefined, 'pending state cleared on commit');

    const next = await Appointment.findOne({ rescheduledFrom: appt._id, status: 'confirmed' }).lean();
    assert.ok(next, 'new confirmed appointment created');
    assert.equal(next.date, DAY);
    assert.equal(next.time, '12:00');
    assert.equal(await redis.get(key), null, 'Redis reservation released after commit');

    // Patient got the confirmation, doctor got the accepted notice.
    assert.ok(outbound.some((o) => o.to === patient.phone && /Done!/.test(o.text) && o.text.includes('12:00')));
    assert.ok(outbound.some((o) => o.to === config.doctorPhone && /ACCEPTED/i.test(o.text)));

    // The locked pipeline side-effects ran exactly like a text reschedule.
    assert.equal(sheetSyncs.filter((s) => s.appointmentId).length, 2, 'both rows mirrored to sheets');
    assert.equal(notifyDoctors.length, 1);
    assert.equal(notifyDoctors[0].event, 'rescheduled');
    assert.equal(reminders.length, 1, 'reminders scheduled for the new slot');
    assert.equal(removedReminders.length, 1, 'old reminders retired');
    assert.ok(removedTimeouts.includes(token), 'timeout job removed');

    // Audit trail: requested → rescheduled (old) → rescheduled (new).
    const audits = await AuditLog.find({ entityId: { $in: [appt._id, next._id] } }).lean();
    cleaned.audits.push(...audits.map((a) => a._id.toString()));
    assert.ok(audits.some((a) => a.action === 'reschedule_requested'));
    const rescheduledAudits = audits.filter((a) => a.action === 'rescheduled');
    assert.equal(rescheduledAudits.length, 2);
    assert.ok(rescheduledAudits.every((a) => a.actor === 'patient'), 'commit records actor patient');
    const oldAudit = rescheduledAudits.find((a) => String(a.entityId) === String(appt._id));
    assert.equal(oldAudit.after.status, 'rescheduled');

    // Inbound tap recorded for dedup.
    assert.ok(await MessageLog.exists({ waMessageId: wamid, direction: 'in' }));
  });

  it('scenario 3 — NO reverts, releases the slot, and stale taps are idempotent', async () => {
    outbound = [];
    buttonSends = [];
    removedTimeouts = [];

    const appt = await createAppointment({ tokenNo: 4003, time: '14:00' });
    const { pendingReschedule } = await propose({ appointmentId: appt._id, newTime: '15:00' });
    const token = pendingReschedule.token;
    const key = marker(config._id, DAY, '15:00');
    cleaned.markers.push(key);
    const wamid = `wamid.in.no.${RUN_DIGITS}`;

    await handleIncomingMessage(
      { body: webhookButtonReply({ phone: patient.phone, buttonId: `RS_NO_${token}`, waMessageId: wamid }), id: `corr.${RUN_DIGITS}` },
      resStub(),
    );

    const row = await Appointment.findById(appt._id).lean();
    assert.equal(row.status, 'confirmed', 'appointment untouched');
    assert.equal(row.date, DAY);
    assert.equal(row.time, '14:00');
    assert.equal(row.pendingReschedule, undefined, 'pending state cleared');
    assert.equal(await redis.get(key), null, 'reserved slot released');
    assert.equal(await Appointment.countDocuments({ rescheduledFrom: appt._id }), 0, 'no replacement row');
    assert.ok(removedTimeouts.includes(token), 'timeout job removed');

    assert.ok(outbound.some((o) => o.to === patient.phone && /No problem/.test(o.text)));
    assert.ok(outbound.some((o) => o.to === config.doctorPhone && /DECLINED/i.test(o.text)));

    const declinedAudit = await AuditLog.findOne({ entityId: appt._id, action: 'reschedule_declined' }).lean();
    cleaned.audits.push(String(declinedAudit._id));
    assert.equal(declinedAudit.actor, 'patient');

    // A stale YES tap after the NO landed is idempotent: skipped + graceful reply.
    const staleWamid = `wamid.in.stale.${RUN_DIGITS}`;
    await handleIncomingMessage(
      { body: webhookButtonReply({ phone: patient.phone, buttonId: `RS_YES_${token}`, waMessageId: staleWamid }), id: `corr.${RUN_DIGITS}` },
      resStub(),
    );
    assert.equal(await Appointment.countDocuments({ rescheduledFrom: appt._id }), 0, 'stale tap must not move anything');
    assert.ok(
      outbound.some((o) => o.to === patient.phone && o.text === rescheduleAlreadyHandled()),
      'stale tap gets the already-handled reply',
    );
  });

  it('scenario 4 — expiry reverts after the window, guarded against early firing', async () => {
    outbound = [];
    removedTimeouts = [];

    const appt = await createAppointment({ tokenNo: 4004, time: '16:00' });
    const { pendingReschedule } = await propose({ appointmentId: appt._id, newTime: '09:30', confirmationTimeoutMs: 60_000 });
    const token = pendingReschedule.token;
    const key = marker(config._id, DAY, '09:30');
    cleaned.markers.push(key);

    // Early invocation (job fired before expiresAt) must NOT revert.
    const early = await expireReschedule(token, testDeps);
    assert.equal(early.skipped, true);
    assert.equal(early.reason, 'not_yet_expired');
    const stillPending = await Appointment.findById(appt._id).lean();
    assert.ok(stillPending.pendingReschedule, 'not reverted by an early fire');
    assert.equal(await redis.get(key), String(appt._id), 'reservation still held');

    // Simulate the confirmation window elapsing (test manipulates the stored
    // timestamps — the same thing a long wait would produce).
    const past = new Date(Date.now() - 60_000);
    await Appointment.updateOne(
      { _id: appt._id },
      { $set: { 'pendingReschedule.requestedAt': past, 'pendingReschedule.expiresAt': past } },
    );

    const result = await expireReschedule(token, testDeps);
    assert.ok(result.resolved);

    const row = await Appointment.findById(appt._id).lean();
    assert.equal(row.status, 'confirmed', 'appointment stays on its original slot');
    assert.equal(row.time, '16:00');
    assert.equal(row.pendingReschedule, undefined, 'pending cleared on expiry');
    assert.equal(await redis.get(key), null, 'slot released on expiry');
    assert.ok(removedTimeouts.includes(token));
    assert.ok(outbound.some((o) => o.to === patient.phone && /expired/i.test(o.text)));
    assert.ok(outbound.some((o) => o.to === config.doctorPhone && /did not respond/i.test(o.text)));

    const expiredAudit = await AuditLog.findOne({ entityId: appt._id, action: 'reschedule_expired' }).lean();
    cleaned.audits.push(String(expiredAudit._id));
    assert.equal(expiredAudit.actor, 'system');

    // Idempotent: a second expiry run is a no-op.
    const again = await expireReschedule(token, testDeps);
    assert.equal(again.skipped, true);
    assert.equal(again.reason, 'no_pending');
  });

  it('scenario 5 — the reserved slot blocks new bookings, and a YES/NO race settles consistently', async () => {
    const appt = await createAppointment({ tokenNo: 4005, time: '10:30' });
    const { pendingReschedule } = await propose({ appointmentId: appt._id, newTime: '12:30' });
    const token = pendingReschedule.token;
    const key = marker(config._id, DAY, '12:30');
    cleaned.markers.push(key);

    // (a) A new booking onto the reserved slot is rejected at every layer.
    await assert.rejects(
      bookAppointment({
        doctorId: config._id,
        date: DAY,
        time: '12:30',
        patient: { _id: otherPatient._id, name: otherPatient.name, phone: otherPatient.phone },
      }),
      (err) => err instanceof SlotTakenError,
      'bookAppointment must reject a slot held by a pending reschedule',
    );
    const preCheck = await checkSlotBookable({ doctorId: config._id, date: DAY, time: '12:30', config });
    assert.equal(preCheck.ok, false);
    assert.equal(preCheck.reason, 'pending_reschedule');
    const near = await findNearestAvailable(config._id, DAY, '09:00');
    assert.ok(!near.some((c) => c.date === DAY && c.time === '12:30'), 'nearest-slot search skips the reserved slot');
    assert.equal(await Appointment.countDocuments({ doctorId: config._id, date: DAY, time: '12:30' }), 0, 'nothing was double-booked');

    // (b) Concurrent YES + NO: Redlock serializes them; exactly one outcome wins
    // and the DB is always consistent — never a double-book or dangling pending.
    await Promise.allSettled([confirmReschedule(token, testDeps), declineReschedule(token, testDeps)]);

    const finalOld = await Appointment.findById(appt._id).lean();
    const replacement = await Appointment.findOne({ rescheduledFrom: appt._id, status: 'confirmed' }).lean();
    assert.equal(await redis.get(key), null, 'race always releases the reservation');
    assert.equal(finalOld.pendingReschedule, undefined, 'race always clears pending');
    if (finalOld.status === 'rescheduled') {
      assert.ok(replacement, 'YES won: replacement row exists');
      assert.equal(replacement.time, '12:30');
      assert.equal(await Appointment.countDocuments({ doctorId: config._id, date: DAY, time: '12:30' }), 1);
      if (replacement) cleaned.appointments.push(replacement._id.toString());
    } else {
      assert.equal(finalOld.status, 'confirmed', 'NO won: appointment untouched');
      assert.equal(replacement, null, 'NO won: no replacement row');
      assert.equal(await Appointment.countDocuments({ doctorId: config._id, date: DAY, time: '12:30' }), 0);
    }
  });
});
