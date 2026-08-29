import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildUnavailableReply, buildSlotTakenReply } from '../../src/orchestrator/intents/book.intent.js';
import { SlotTakenError } from '../../src/utils/errors.js';
import { closeRedis } from '../../src/config/redis.js';
import { closeInboundQueue } from '../../src/queues/inboundMessage.queue.js';
import { closeSheetsQueues } from '../../src/queues/sheetsSync.queue.js';
import { closeNotifyDoctorQueues } from '../../src/queues/notifyDoctor.queue.js';
import { closeNotifyPatientQueue } from '../../src/queues/notifyPatient.queue.js';
import { closeRemindersQueues } from '../../src/queues/reminders.queue.js';

// Importing book.intent.js pulls in Redis/BullMQ modules that keep the event
// loop alive — release them so `node --test` can exit (mirrors nlu.safety.test.js).
after(async () => {
  await closeInboundQueue();
  await closeSheetsQueues();
  await closeNotifyDoctorQueues();
  await closeNotifyPatientQueue();
  await closeRemindersQueues();
  await closeRedis();
});

// buildUnavailableReply is the shared renderer for the EARLY slot validation
// (collection-time rejection, item) and the confirm-time SlotTaken fallback.
// Every unavailability reason gets a reason-specific headline so the patient is
// never told "already taken" about a holiday or a closed day.

const ALTS = [
  { date: '2099-01-06', time: '09:00' },
  { date: '2099-01-06', time: '09:20' },
];

describe('buildUnavailableReply (early slot validation reply)', () => {
  it('slot_taken falls back to the friendly default headline', () => {
    const reply = buildUnavailableReply('2099-01-05', '10:00', 'slot_taken', ALTS);
    assert.ok(reply.includes('2099-01-05 at 10:00 is already taken'));
    assert.ok(reply.includes('Nearest available options'));
    assert.ok(reply.includes('1. 2099-01-06 at 09:00'));
    assert.ok(reply.includes('2. 2099-01-06 at 09:20'));
  });

  it('maps each schedule reason to its own headline', () => {
    assert.ok(buildUnavailableReply('2099-01-05', '10:00', 'holiday').includes('closed on 2099-01-05'));
    assert.ok(buildUnavailableReply('2099-01-05', '10:00', 'closed_day').includes('closed on 2099-01-05'));
    assert.ok(buildUnavailableReply('2099-01-05', '10:00', 'outside_hours').includes('outside'));
    assert.ok(buildUnavailableReply('2099-01-05', '10:00', 'break_time').includes('break'));
    assert.ok(buildUnavailableReply('2099-01-05', '10:00', 'in_the_past').includes('already passed'));
    assert.ok(buildUnavailableReply('2099-01-05', '10:00', 'no_config').includes('No clinic schedule'));
  });

  it('says no free slot found when there are no alternatives', () => {
    const reply = buildUnavailableReply('2099-01-05', '10:00', 'slot_taken', []);
    assert.ok(reply.includes('could not find any other free slot'));
    assert.ok(!reply.includes('Nearest available options'));
  });
});

describe('buildSlotTakenReply (confirm-time fallback)', () => {
  it('renders the reason carried by SlotTakenError', () => {
    const err = new SlotTakenError('2099-01-05', '10:00', null, { reason: 'in_the_past' });
    const reply = buildSlotTakenReply(err, []);
    assert.ok(reply.includes('already passed'));
  });
});
