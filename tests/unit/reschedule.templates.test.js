import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rescheduleSummary } from '../../src/orchestrator/intents/reschedule.intent.js';
import { LANG } from '../../src/services/localization.service.js';
import { closeRedis } from '../../src/config/redis.js';
import { closeInboundQueue } from '../../src/queues/inboundMessage.queue.js';
import { closeSheetsQueues } from '../../src/queues/sheetsSync.queue.js';
import { closeNotifyDoctorQueues } from '../../src/queues/notifyDoctor.queue.js';
import { closeNotifyPatientQueue } from '../../src/queues/notifyPatient.queue.js';
import { closeRemindersQueues } from '../../src/queues/reminders.queue.js';

// Importing reschedule.intent.js pulls in Redis/BullMQ modules that keep the
// event loop alive — release them so `node --test` can exit (mirrors
// book.intent.test.js).
after(async () => {
  await closeInboundQueue();
  await closeSheetsQueues();
  await closeNotifyDoctorQueues();
  await closeNotifyPatientQueue();
  await closeRemindersQueues();
  await closeRedis();
});

// The reschedule summary is UI-converted to WhatsApp reply buttons: the
// trailing "Reply YES to confirm, or NO to change something." instruction line
// is gone (the buttons carry confirm_booking_yes / confirm_booking_no) while
// the body text is unchanged. The typed-word fallback still works, so nothing
// in the wording may be touched.

const TARGET = { date: '2026-08-16', time: '09:00', tokenNo: 7 };
const SLOTS = { date: '2026-08-17', time: '10:00' };
const NEXT_LINE = 'New: 2026-08-17 at 10:00';
const REMOVED_INSTRUCTIONS = ['Reply YES to confirm, or NO to change something.', 'CANCEL or RESCHEDULE'];

describe('rescheduleSummary (interactive buttons replace the text instruction)', () => {
  it('bilingual default (English / Roman-Urdu) renders current + new with no trailing instruction line', () => {
    for (const lang of [undefined, LANG.ENGLISH, LANG.ROMAN_URDU]) {
      const text = rescheduleSummary(TARGET, SLOTS, lang);
      assert.ok(text.includes('Current: 2026-08-16 at 09:00 (Token #7)'), `${lang} keeps the current line`);
      assert.ok(text.includes(NEXT_LINE), `${lang} keeps the new line`);
      for (const phrase of REMOVED_INSTRUCTIONS) {
        assert.ok(!text.includes(phrase), `${lang}: "${phrase}" removed`);
      }
      const lines = text.split('\n');
      assert.equal(lines.at(-1), NEXT_LINE, `${lang}: body ends at the new slot, nothing appended`);
    }
  });

  it('script templates (Urdu/Sindhi/Pashto/Balochi) render the slot body and drop the instruction line too', () => {
    for (const lang of [LANG.URDU, LANG.SINDHI, LANG.PASHTO, LANG.BALOCHI]) {
      const text = rescheduleSummary(TARGET, SLOTS, lang);
      assert.match(text, /[\u0600-\u06FF]/, `${lang} uses script`);
      assert.ok(text.includes('2026-08-16 at 09:00 (Token #7)'), `${lang} keeps the current line`);
      assert.ok(text.includes('2026-08-17 at 10:00'), `${lang} keeps the new line`);
      for (const phrase of REMOVED_INSTRUCTIONS) {
        assert.ok(!text.includes(phrase), `${lang}: "${phrase}" removed`);
      }
      const lines = text.split('\n');
      assert.ok(lines.at(-1).includes('2026-08-17 at 10:00'), `${lang}: last line is the new slot`);
      assert.ok(lines.length >= 3, `${lang}: summary keeps its own structure`);
    }
  });
});
