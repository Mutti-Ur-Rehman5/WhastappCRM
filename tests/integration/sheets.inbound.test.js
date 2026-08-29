import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { redis } from '../../src/config/redis.js';
import { Appointment } from '../../src/models/Appointment.model.js';
import { AuditLog } from '../../src/models/AuditLog.model.js';
import { DoctorConfig, WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import { Patient } from '../../src/models/Patient.model.js';
import { rowMapKey } from '../../src/services/sheets.service.js';
import {
  pollSheetsInbound,
  selfHealFailedSyncs,
  startSheetsJobs,
} from '../../src/jobs/sheetsInboundPoll.job.js';
import { invalidateDoctorConfigCache } from '../../src/services/slot.service.js';

// Inbound Sheet → DB reconciliation (DESIGN.md §7) with a mocked googleapis
// client. Proves:
//   - a doctor Status edit flows back into the DB with an AuditLog actor:'doctor'
//   - structural columns (date/time/patient) are NEVER written back
//   - newer-wins: a stale sheet snapshot does not undo a newer DB change
//   - the row map is rebuilt every poll, and self-heal re-enqueues failed rows

const HEADER = ['Token No', 'Patient Name', 'Patient Phone', 'Date', 'Time', 'Status', 'Updated At', 'Notes'];
let sheetRows = [HEADER];

const fakeSheetsClient = {
  spreadsheets: {
    values: {
      async get() {
        return { data: { values: sheetRows } };
      },
    },
  },
};

let doctorConfig;
let patient;

async function seedAppointment({ tokenNo, time, status = 'confirmed', updatedAt = new Date() }) {
  const appt = await Appointment.create({
    tokenNo,
    doctorId: doctorConfig._id,
    patientId: patient._id,
    patientName: 'Poll Patient',
    patientPhone: patient.phone,
    date: '2026-09-01',
    time,
    slotStart: dayjs(`${'2026-09-01'}T${time}:00`).toDate(),
    status,
    notes: '',
  });
  await Appointment.updateOne({ _id: appt._id }, { $set: { updatedAt } }, { timestamps: false });
  return Appointment.findById(appt._id).lean();
}

function sheetRow(appt, { status = appt.status, updatedAt = appt.updatedAt, overrides = {} } = {}) {
  const iso = new Date(updatedAt).toISOString();
  return [
    overrides.tokenNo ?? appt.tokenNo,
    overrides.patientName ?? appt.patientName,
    overrides.patientPhone ?? appt.patientPhone,
    overrides.date ?? appt.date,
    overrides.time ?? appt.time,
    status,
    iso,
    overrides.notes ?? appt.notes ?? '',
  ];
}

before(async () => {
  await connectTestDb();
  await redis.del(rowMapKey());
  await AuditLog.deleteMany({ actor: 'doctor' });
  await Patient.deleteMany({ phone: /^\+923004100/ });
  await Appointment.deleteMany({ patientPhone: /^\+923004100/ });
  await DoctorConfig.deleteMany({ doctorName: 'sheets.inbound.test.config' });
  doctorConfig = await DoctorConfig.create({
    doctorName: 'sheets.inbound.test.config',
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
  patient = await Patient.create({ name: 'Poll Patient', phone: '+923004100001' });
  await invalidateDoctorConfigCache();
});

after(async () => {
  await redis.del(rowMapKey());
  await closeTestDb();
  await redis.quit();
});

describe('sheets inbound poll (mocked googleapis)', () => {
  it('applies a doctor Status edit to the DB and writes an AuditLog row with actor:doctor', async () => {
    const appt = await seedAppointment({ tokenNo: 5001, time: '10:00' });
    sheetRows = [HEADER, sheetRow(appt, { status: 'completed' })];

    const results = await pollSheetsInbound({ sheetsClient: fakeSheetsClient });
    assert.equal(results.length, 1);
    assert.equal(results[0].applied, true);
    assert.equal(results[0].changed.status, 'completed');

    const doc = await Appointment.findById(appt._id).lean();
    assert.equal(doc.status, 'completed', 'doctor Status edit flows into MongoDB');

    const audits = await AuditLog.find({ entityId: appt._id, actor: 'doctor' }).lean();
    assert.equal(audits.length, 1, 'exactly one doctor audit row');
    assert.equal(audits[0].action, 'status_changed_by_doctor');
    assert.equal(audits[0].before.status, 'confirmed');
    assert.equal(audits[0].after.status, 'completed');
  });

  it('NEVER writes date/time/patient columns back, even if the sheet is mocked as changed', async () => {
    const appt = await seedAppointment({ tokenNo: 5002, time: '10:15' });
    const before = await Appointment.findById(appt._id).lean();
    // Malicious/heavy-handed sheet edit: every structural field changed AND a
    // notes edit (notes IS doctor-editable, so that part should apply).
    sheetRows = [
      HEADER,
      sheetRow(appt, {
        overrides: {
          patientName: 'Evil Hacker',
          patientPhone: '+999999999999',
          date: '2027-01-01',
          time: '09:00',
          notes: 're-check in 3 days',
        },
      }),
    ];

    const results = await pollSheetsInbound({ sheetsClient: fakeSheetsClient });
    assert.equal(results[0].applied, true, 'notes edit applies');

    const doc = await Appointment.findById(appt._id).lean();
    // Conflict rule (DESIGN.md §7): structural fields are silently ignored —
    // applying them would bypass the atomic locking pipeline and reintroduce
    // double-booking risk; the next outbound sync overwrites them.
    assert.equal(doc.patientName, before.patientName, 'patientName is NOT applied from the sheet');
    assert.equal(doc.patientPhone, before.patientPhone, 'patientPhone is NOT applied from the sheet');
    assert.equal(doc.date, before.date, 'date is NOT applied from the sheet');
    assert.equal(doc.time, before.time, 'time is NOT applied from the sheet');
    assert.equal(doc.notes, 're-check in 3 days', 'notes IS doctor-editable and applies');
  });

  it('newer-wins: a stale sheet snapshot does not undo a newer DB change', async () => {
    const now = new Date();
    const stale = new Date(now.getTime() - 60 * 60 * 1000);
    const appt = await seedAppointment({ tokenNo: 5003, time: '10:30', status: 'cancelled', updatedAt: now });
    // Sheet still shows the pre-cancel confirmed state with a stale timestamp.
    sheetRows = [
      HEADER,
      sheetRow(appt, { status: 'confirmed', updatedAt: stale, overrides: { time: '10:30' } }),
    ];

    const results = await pollSheetsInbound({ sheetsClient: fakeSheetsClient });
    assert.equal(results[0].applied, false);
    assert.equal(results[0].reason, 'db_newer', 'DB changed after the sheet snapshot — DB wins');

    const doc = await Appointment.findById(appt._id).lean();
    assert.equal(doc.status, 'cancelled', 'the WhatsApp cancel is not undone by a stale sheet');
    const audits = await AuditLog.find({ entityId: appt._id, actor: 'doctor' }).lean();
    assert.equal(audits.length, 0, 'no doctor audit row for a skipped edit');
  });

  it('rebuilds the Redis row map from the whole sheet each poll', async () => {
    const a = await seedAppointment({ tokenNo: 5004, time: '10:45' });
    const b = await seedAppointment({ tokenNo: 5005, time: '11:00' });
    sheetRows = [HEADER, sheetRow(a, { status: 'no-show' }), sheetRow(b)];

    await pollSheetsInbound({ sheetsClient: fakeSheetsClient });

    const map = await redis.hgetall(rowMapKey());
    assert.equal(map['5004'], '2', 'first data row maps to sheet row 2');
    assert.equal(map['5005'], '3', 'second data row maps to sheet row 3');
  });

  it('self-heal re-enqueues appointments whose sync failed', async () => {
    const failed = await seedAppointment({ tokenNo: 5006, time: '11:15' });
    await Appointment.updateOne({ _id: failed._id }, { $set: { sheetSyncStatus: 'failed' } });
    const healthy = await seedAppointment({ tokenNo: 5007, time: '11:30' });

    const enqueued = [];
    const spyEnqueue = async ({ appointmentId }) => enqueued.push(String(appointmentId));

    const count = await selfHealFailedSyncs({ enqueue: spyEnqueue, limit: 100 });
    assert.equal(count, 1);
    assert.deepEqual(enqueued, [String(failed._id)], 'only the failed appointment is re-enqueued');
    assert.ok(!enqueued.includes(String(healthy._id)));
  });

  it('startSheetsJobs starts both crons and can be stopped', () => {
    const jobs = startSheetsJobs();
    assert.equal(typeof jobs.stop, 'function');
    jobs.stop();
  });
});
