import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../../helpers/db.js';
import { redis } from '../../../src/config/redis.js';
import { Appointment } from '../../../src/models/Appointment.model.js';
import { Patient } from '../../../src/models/Patient.model.js';
import { DoctorConfig } from '../../../src/models/DoctorConfig.model.js';
import { getInboundQueue, closeInboundQueue } from '../../../src/queues/inboundMessage.queue.js';
import { bookAppointment } from '../../../src/services/booking.service.js';
import { SlotTakenError } from '../../../src/utils/errors.js';
import {
  makeDoctorConfig,
  runConversationLoad,
  assertConversationResults,
  invalidateDoctorConfigCache,
  cleanupPhonePrefix,
} from './helpers.js';

// Phase 9 DoD — the slot lock must hold even while the system is at full load:
// 50 distinct patients race bookAppointment() for the EXACT same
// {doctorId, date, time} WHILE 100 other conversations are flowing through the
// real BullMQ worker + Mongo + Redis. Asserts exactly 1 winner, 49
// SlotTakenErrors, and that the 100 conversations all still complete cleanly.

const LOAD_DOCTOR = 'load50-under-load.config';
const HAMMER_DOCTOR = 'hammer-under-load.config';
const LOAD_PREFIX = '+9230880000';
const HAMMER_PREFIX = '+9230870000';
const HAMMER_DATE = '2099-03-10';
const HAMMER_TIME = '09:00';
const N_HAMMER = 50;

let loadConfig;
let hammerConfig;
let hammerPatients;
let loadWorker;

before(async () => {
  await connectTestDb();
  await DoctorConfig.deleteMany({ doctorName: { $in: [LOAD_DOCTOR, HAMMER_DOCTOR] } });
  await cleanupPhonePrefix(LOAD_PREFIX);
  await cleanupPhonePrefix(HAMMER_PREFIX);
  await getInboundQueue().obliterate({ force: true }).catch(() => {});
  loadConfig = await makeDoctorConfig({ doctorName: LOAD_DOCTOR, doctorPhone: '+923001239985' });
  hammerConfig = await makeDoctorConfig({ doctorName: HAMMER_DOCTOR, doctorPhone: '+923001239986' });
  await invalidateDoctorConfigCache();
  hammerPatients = await Promise.all(
    Array.from({ length: N_HAMMER }, (_, i) =>
      Patient.create({ name: `Hammer ${i}`, phone: `${HAMMER_PREFIX}${String(i).padStart(4, '0')}` }),
    ),
  );
});

after(async () => {
  try {
    await loadWorker?.close();
    await getInboundQueue().obliterate({ force: true }).catch(() => {});
    await closeInboundQueue();
    await cleanupPhonePrefix(LOAD_PREFIX);
    await cleanupPhonePrefix(HAMMER_PREFIX);
    await DoctorConfig.deleteMany({ doctorName: { $in: [LOAD_DOCTOR, HAMMER_DOCTOR] } });
  } finally {
    await closeTestDb();
    await redis.quit();
  }
});

describe('load: 50-parallel-same-slot contention WHILE 100 conversations are in flight', () => {
  it('exactly 1 winner + 49 SlotTakenErrors under load; all 100 conversations still complete', async () => {
    let hammerPromise;
    const loadPromise = runConversationLoad({
      nPhones: 100,
      phonePrefix: LOAD_PREFIX,
      doctorConfig: loadConfig,
      startDate: '2099-03-01',
      // The worker is up and draining the 300-job backlog when the 50-way race
      // fires — the slot lock is proven under genuine concurrent load.
      onWorkerStarted: () => {
        hammerPromise = Promise.allSettled(
          hammerPatients.map((p) =>
            bookAppointment({ doctorId: hammerConfig._id, date: HAMMER_DATE, time: HAMMER_TIME, patient: p, reason: 'hammer' }),
          ),
        );
        return hammerPromise;
      },
    });

    const loadResult = await loadPromise;
    loadWorker = loadResult.worker;
    const hammerResults = await hammerPromise;

    const successes = hammerResults.filter((r) => r.status === 'fulfilled');
    const failures = hammerResults.filter((r) => r.status === 'rejected');
    assert.equal(successes.length, 1, 'exactly one hammer booking must win under load');
    assert.equal(failures.length, N_HAMMER - 1, 'all other hammer callers must lose under load');
    for (const f of failures) {
      assert.ok(f.reason instanceof SlotTakenError, `expected SlotTakenError, got ${f.reason?.message}`);
    }
    const inDb = await Appointment.countDocuments({ doctorId: hammerConfig._id, date: HAMMER_DATE, time: HAMMER_TIME });
    assert.equal(inDb, 1, 'exactly one Appointment row for the hammer slot');

    await assertConversationResults({
      doctorConfig: loadConfig,
      nPhones: 100,
      seen: loadResult.seen,
      peak: loadResult.peak,
      failed: loadResult.failed,
    });
  });
});
