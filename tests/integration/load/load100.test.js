import { describe, it, before, after } from 'node:test';
import { connectTestDb, closeTestDb } from '../../helpers/db.js';
import { redis } from '../../../src/config/redis.js';
import { DoctorConfig } from '../../../src/models/DoctorConfig.model.js';
import { getInboundQueue, closeInboundQueue } from '../../../src/queues/inboundMessage.queue.js';
import {
  makeDoctorConfig,
  runConversationLoad,
  assertConversationResults,
  invalidateDoctorConfigCache,
  cleanupPhonePrefix,
} from './helpers.js';

// Phase 9 DoD — 100 concurrent DISTINCT conversations (300 inbound jobs) through
// the REAL BullMQ worker + Mongo + Redis. Deterministic scripted NLU (RULES.md
// §7: no live Gemini); the only thing being load-tested is the pipeline itself.
// Asserts: every conversation books exactly once, tokenNos unique, zero failed
// jobs, strict per-phone FIFO ordering, and real cross-phone parallelism.

const N = 100;
const DOCTOR_NAME = 'load100.test.config';
const PHONE_PREFIX = '+9230990000';
const START_DATE = '2099-02-01';

let config;
let worker;

before(async () => {
  await connectTestDb();
  await DoctorConfig.deleteMany({ doctorName: DOCTOR_NAME });
  await cleanupPhonePrefix(PHONE_PREFIX);
  await getInboundQueue().obliterate({ force: true }).catch(() => {});
  config = await makeDoctorConfig({ doctorName: DOCTOR_NAME, doctorPhone: '+923001239990' });
  await invalidateDoctorConfigCache();
});

after(async () => {
  try {
    await worker?.close();
    await getInboundQueue().obliterate({ force: true }).catch(() => {});
    await closeInboundQueue();
    await cleanupPhonePrefix(PHONE_PREFIX);
    await DoctorConfig.deleteMany({ doctorName: DOCTOR_NAME });
  } finally {
    await closeTestDb();
    await redis.quit();
  }
});

describe('load: 100 concurrent distinct conversations (full book flow)', () => {
  it('books all 100 with unique tokens, zero failures, per-phone ordering, real parallelism', async () => {
    const result = await runConversationLoad({
      nPhones: N,
      phonePrefix: PHONE_PREFIX,
      doctorConfig: config,
      startDate: START_DATE,
    });
    worker = result.worker;
    await assertConversationResults({
      doctorConfig: config,
      nPhones: N,
      seen: result.seen,
      peak: result.peak,
      failed: result.failed,
    });
  });
});
