import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../../helpers/db.js';
import { redis } from '../../../src/config/redis.js';
import { Appointment } from '../../../src/models/Appointment.model.js';
import { Patient } from '../../../src/models/Patient.model.js';
import { DoctorConfig } from '../../../src/models/DoctorConfig.model.js';
import { MessageLog } from '../../../src/models/MessageLog.model.js';
import { bookAppointment } from '../../../src/services/booking.service.js';
import { sendTextMessage } from '../../../src/services/whatsapp.service.js';
import { processNotifyDoctorJob } from '../../../src/queues/notifyDoctor.queue.js';
import { makeDoctorConfig } from '../load/helpers.js';
import { invalidateDoctorConfigCache } from '../../../src/services/slot.service.js';

// DESIGN.md §10: "WhatsApp send fail → 3x retry; email fallback for
// doctor-notify only". Two layers: the Graph API call itself is retried with
// backoff (never a bare unretried call — RULES.md §4), and the doctor
// notification ALWAYS also goes out by email (clinic preference), so a
// WhatsApp outage never leaves the doctor uninformed.

function failingHttp(attemptsCounter) {
  return {
    post: async () => {
      attemptsCounter.count += 1;
      const err = new Error('WhatsApp Graph API 503 (chaos)');
      err.response = { status: 503 };
      throw err;
    },
  };
}

let config;
let appointment;

before(async () => {
  await connectTestDb();
  await DoctorConfig.deleteMany({ doctorName: 'whatsapp-chaos.config' });
  config = await makeDoctorConfig({ doctorName: 'whatsapp-chaos.config', doctorPhone: '+923001239984' });
  await invalidateDoctorConfigCache();
  await Appointment.deleteMany({ doctorId: config._id });
  await MessageLog.deleteMany({ phone: config.doctorPhone });
  const patient = await Patient.create({ name: 'WhatsApp Chaos', phone: '+923099123004' });
  appointment = await bookAppointment({
    doctorId: config._id,
    date: '2099-08-05',
    time: '11:00',
    patient,
    reason: 'chaos',
  });
});

after(async () => {
  await Appointment.deleteMany({ doctorId: config._id });
  await Patient.deleteMany({ phone: '+923099123004' });
  await MessageLog.deleteMany({ phone: config.doctorPhone });
  await DoctorConfig.deleteMany({ doctorName: 'whatsapp-chaos.config' });
  await closeTestDb();
  await redis.quit();
});

describe('chaos: WhatsApp API failure → 3x retry, email always delivered for doctor (DESIGN.md §10)', () => {
  it('sendTextMessage retries a retryable 5xx exactly 3 times with backoff', async () => {
    const attemptsCounter = { count: 0 };
    await assert.rejects(
      sendTextMessage({
        to: '+923099123004',
        text: 'hello',
        http: failingHttp(attemptsCounter),
        options: { attempts: 3, baseDelayMs: 5, jitterMs: 0 },
      }),
      /WhatsApp Graph API 503/,
    );
    assert.equal(attemptsCounter.count, 3, 'a retryable 5xx must be retried exactly 3 times');
  });

  it('doctor notification still delivers the email when WhatsApp exhausts its 3 retries', async () => {
    const attemptsCounter = { count: 0 };
    const job = { id: 'notify-doctor-chaos', data: { appointmentId: String(appointment._id), event: 'booked' } };
    const result = await processNotifyDoctorJob(job, {
      send: (args) =>
        sendTextMessage({
          ...args,
          http: failingHttp(attemptsCounter),
          options: { attempts: 3, baseDelayMs: 5, jitterMs: 0 },
        }),
      sendEmail: async ({ to, subject, text }) => ({ messageId: 'mail-fallback-chaos' }),
      loadConfig: async () => DoctorConfig.findById(config._id).lean(),
    });

    assert.equal(attemptsCounter.count, 3, 'WhatsApp must be retried 3x before giving up');
    assert.equal(result.channel, 'email');
    assert.equal(result.messageId, 'mail-fallback-chaos');
    assert.equal(result.emailSent, true);

    const emailLog = await MessageLog.findOne({ phone: config.doctorPhone, direction: 'out', channel: 'email' }).lean();
    assert.ok(emailLog, 'the email must be written to MessageLog');
  });

  it('email is ALSO sent when WhatsApp succeeds (always-notify, not a fallback)', async () => {
    const job = { id: 'notify-doctor-both-ok', data: { appointmentId: String(appointment._id), event: 'booked' } };
    const result = await processNotifyDoctorJob(job, {
      send: async () => 'wamid.doctor.ok',
      sendEmail: async ({ to, subject, text }) => ({ messageId: 'mail-always-chaos' }),
      loadConfig: async () => DoctorConfig.findById(config._id).lean(),
    });

    assert.equal(result.channel, 'whatsapp', 'WhatsApp remains the primary channel');
    assert.equal(result.emailSent, true, 'the email must be attempted regardless');

    const emailLog = await MessageLog.findOne({ phone: config.doctorPhone, direction: 'out', channel: 'email' }).lean();
    assert.ok(emailLog, 'email MessageLog row written even when WhatsApp succeeded');
    const whatsappLog = await MessageLog.findOne({ phone: config.doctorPhone, direction: 'out', channel: 'whatsapp' }).lean();
    assert.ok(whatsappLog, 'whatsapp MessageLog row written');
  });
});
