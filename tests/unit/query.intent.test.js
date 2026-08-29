import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleReply } from '../../src/orchestrator/intents/query.intent.js';
import { WEEKDAYS } from '../../src/models/DoctorConfig.model.js';
import { closeRedis } from '../../src/config/redis.js';
import { closeInboundQueue } from '../../src/queues/inboundMessage.queue.js';
import { closeSheetsQueues } from '../../src/queues/sheetsSync.queue.js';
import { closeNotifyDoctorQueues } from '../../src/queues/notifyDoctor.queue.js';
import { closeNotifyPatientQueue } from '../../src/queues/notifyPatient.queue.js';
import { closeRemindersQueues } from '../../src/queues/reminders.queue.js';

// Importing query.intent.js pulls in Redis/BullMQ modules that keep the event
// loop alive — release them so `node --test` can exit (mirrors nlu.safety.test.js).
after(async () => {
  await closeInboundQueue();
  await closeSheetsQueues();
  await closeNotifyDoctorQueues();
  await closeNotifyPatientQueue();
  await closeRemindersQueues();
  await closeRedis();
});

const CONFIG = {
  doctorName: 'Dr Ayesha Khan',
  workingHours: WEEKDAYS.map((day) => ({
    day,
    enabled: day !== 'sunday',
    start: '09:00',
    end: '17:00',
    slotMinutes: 15,
    breaks: [{ start: '13:00', end: '14:00' }],
  })),
  holidays: ['2026-12-25'],
};

describe('buildScheduleReply (check_availability without a date, "doctor ka schedule bta do")', () => {
  it('lists every weekday with its working hours and break', () => {
    const reply = buildScheduleReply(CONFIG);
    assert.ok(reply.includes('Dr Ayesha Khan'));
    assert.ok(reply.includes('Monday: 09:00 – 17:00 (break 13:00–14:00)'));
    assert.ok(reply.includes('Sunday: Closed / Band'));
    assert.ok(reply.includes('2026-12-25'), 'holidays are listed');
  });
});
