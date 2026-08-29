import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { Appointment } from '../../src/models/Appointment.model.js';
import { Patient } from '../../src/models/Patient.model.js';
import { Conversation } from '../../src/models/Conversation.model.js';
import { DoctorConfig } from '../../src/models/DoctorConfig.model.js';
import { Counter } from '../../src/models/Counter.model.js';
import { AuditLog } from '../../src/models/AuditLog.model.js';
import { MessageLog } from '../../src/models/MessageLog.model.js';

const doctorId = () => new mongoose.Types.ObjectId();
const patientId = () => new mongoose.Types.ObjectId();

// Unique per process-run so tests stay idempotent against the shared dev DB.
const RUN_DIGITS = Date.now().toString().slice(-8);
const uniqPhone = (n) => `+923${RUN_DIGITS}${String(n).padStart(3, '0')}`;
const uniqWamid = (tag) => `wamid.${tag}.${RUN_DIGITS}`;

const validAppointment = (overrides = {}) => ({
  tokenNo: 1,
  doctorId: doctorId(),
  patientId: patientId(),
  patientName: 'Ahmed Raza',
  patientPhone: '+923001234567',
  date: '2026-08-03',
  time: '10:00',
  slotStart: new Date('2026-08-03T05:00:00Z'),
  reason: 'Fever checkup',
  ...overrides,
});

before(async () => {
  await connectTestDb();
  // Force index build so unique-index assertions are deterministic.
  await Promise.all([
    Appointment.init(),
    Patient.init(),
    Conversation.init(),
    DoctorConfig.init(),
    Counter.init(),
    AuditLog.init(),
    MessageLog.init(),
  ]);
});

after(async () => {
  await closeTestDb();
});

describe('Appointment model', () => {
  it('creates with defaults: status=confirmed, sheetSyncStatus=pending', async () => {
    const appt = await Appointment.create(validAppointment());
    assert.equal(appt.status, 'confirmed');
    assert.equal(appt.sheetSyncStatus, 'pending');
    assert.ok(appt.createdAt instanceof Date);
  });

  it('rejects a missing required field', async () => {
    const doc = new Appointment(validAppointment({ patientName: undefined }));
    await assert.rejects(doc.validate(), /patientName/);
  });

  it('rejects an invalid status enum value', async () => {
    const doc = new Appointment(validAppointment({ status: 'booked' }));
    await assert.rejects(doc.validate(), /status/);
  });

  it('rejects a non-E.164 phone number', async () => {
    const doc = new Appointment(validAppointment({ patientPhone: '0300-1234567' }));
    await assert.rejects(doc.validate(), /patientPhone/);
  });

  it('rejects a malformed 24h time', async () => {
    const doc = new Appointment(validAppointment({ time: '25:99' }));
    await assert.rejects(doc.validate(), /time/);
  });

  it('unique partial index: second active booking on same slot is rejected', async () => {
    const doc = doctorId();
    await Appointment.create(validAppointment({ tokenNo: 2, doctorId: doc }));
    // Cancelled appt on the same slot is allowed (partial index excludes it).
    await Appointment.create(validAppointment({ tokenNo: 3, doctorId: doc, status: 'cancelled' }));
    // A second pending/confirmed booking on the same slot must fail with E11000.
    await assert.rejects(
      Appointment.create(validAppointment({ tokenNo: 4, doctorId: doc, status: 'pending' })),
      (err) => err.code === 11000,
    );
  });
});

describe('Patient model', () => {
  it('creates with name and E.164 phone', async () => {
    const patient = await Patient.create({ name: 'Ahmed Raza', phone: uniqPhone(1) });
    assert.equal(patient.phone, uniqPhone(1));
  });

  it('rejects a missing name', async () => {
    const doc = new Patient({ phone: uniqPhone(2) });
    await assert.rejects(doc.validate(), /name/);
  });

  it('enforces unique phone', async () => {
    const phone = uniqPhone(3);
    await Patient.create({ name: 'First', phone });
    await assert.rejects(
      Patient.create({ name: 'Second', phone }),
      (err) => err.code === 11000,
    );
  });
});

describe('Conversation model', () => {
  it('defaults to state IDLE with no pending intent', async () => {
    const conv = new Conversation({ phone: '+923001111222' });
    await conv.validate();
    assert.equal(conv.state, 'IDLE');
    assert.equal(conv.pendingIntent, null);
    assert.deepEqual(conv.slots.toObject(), {});
  });

  it('rejects an unknown state', async () => {
    const doc = new Conversation({ phone: '+923001111222', state: 'SLEEPING' });
    await assert.rejects(doc.validate(), /state/);
  });
});

describe('DoctorConfig model', () => {
  const validConfig = () => ({
    doctorName: 'Dr. Test',
    doctorPhone: '+923001234567',
    workingHours: [{ day: 'monday', enabled: true, start: '09:00', end: '17:00', slotMinutes: 15, breaks: [] }],
  });

  it('applies defaults: timezone, bufferMinutes, maxPerSlot, reminderOffsetsHours', async () => {
    const config = await DoctorConfig.create(validConfig());
    assert.equal(config.timezone, 'Asia/Karachi');
    assert.equal(config.bufferMinutes, 5);
    assert.equal(config.maxPerSlot, 1);
    assert.deepEqual(config.reminderOffsetsHours, [24, 2]);
  });

  it('rejects an invalid weekday', async () => {
    const doc = new DoctorConfig(validConfig());
    doc.workingHours[0].day = 'funday';
    await assert.rejects(doc.validate(), /workingHours/);
  });
});

describe('AuditLog model', () => {
  it('creates a valid audit entry with ts set', async () => {
    const log = await AuditLog.create({
      entity: 'appointment',
      entityId: doctorId(),
      action: 'booked',
      actor: 'patient',
      before: { status: 'pending' },
      after: { status: 'confirmed' },
    });
    assert.ok(log.ts instanceof Date);
  });

  it('rejects a missing actor', async () => {
    const doc = new AuditLog({ entity: 'appointment', entityId: doctorId(), action: 'booked' });
    await assert.rejects(doc.validate(), /actor/);
  });

  it('rejects an unknown entity', async () => {
    const doc = new AuditLog({ entity: 'prescription', entityId: doctorId(), action: 'x', actor: 'patient' });
    await assert.rejects(doc.validate(), /entity/);
  });
});

describe('MessageLog model', () => {
  it('creates an inbound WhatsApp message', async () => {
    const msg = await MessageLog.create({
      phone: uniqPhone(4),
      direction: 'in',
      channel: 'whatsapp',
      body: 'kal shaam appointment chahiye',
      waMessageId: uniqWamid('create'),
    });
    assert.equal(msg.channel, 'whatsapp');
  });

  it('dedupes by waMessageId at the DB level', async () => {
    const waMessageId = uniqWamid('dedupe');
    await MessageLog.create({
      phone: uniqPhone(5),
      direction: 'in',
      body: 'first delivery',
      waMessageId,
    });
    await assert.rejects(
      MessageLog.create({
        phone: uniqPhone(5),
        direction: 'in',
        body: 'redelivery',
        waMessageId,
      }),
      (err) => err.code === 11000,
    );
  });
});
