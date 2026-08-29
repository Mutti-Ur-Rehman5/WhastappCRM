import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  patientConfirmation,
  patientReminder,
  doctorNotification,
  NOTIFY_EVENT_LABELS,
} from '../../src/prompts/templates.js';

// DESIGN.md §8: the notification templates are parameterized and are the single
// source of truth — the same strings are used by the WhatsApp sends AND the
// email fallback body, so the doctor sees identical content on both channels.

const APPT = {
  tokenNo: 42,
  date: '2026-08-05',
  time: '10:30',
  doctorName: 'Dr. Aslam',
  reason: 'fever',
};

describe('prompts/templates (DESIGN.md §8)', () => {
  it('patientConfirmation is the exact §8 confirmation (interactive buttons replace the trailing text line)', () => {
    const text = patientConfirmation(APPT);
    assert.ok(text.includes('Appointment confirmed. Token #42.'));
    assert.ok(text.includes('2026-08-05 at 10:30 with Dr. Aslam.'));
    assert.ok(text.includes('Reason: fever'));
    assert.ok(!text.includes('Reply CANCEL or RESCHEDULE'), 'the text instruction is replaced by the Cancel/Reschedule buttons');
  });

  it('patientConfirmation falls back for a missing doctorName and reason', () => {
    const text = patientConfirmation({ tokenNo: 1, date: '2026-08-05', time: '09:00' });
    assert.ok(text.includes('with the doctor.'));
    assert.ok(text.includes('Reason: -'));
  });

  it('patientReminder carries token/date/time', () => {
    const text = patientReminder({ tokenNo: 7, date: '2026-08-05', time: '09:00' });
    assert.equal(text, '⏰ Reminder: your appointment (Token #7) is on 2026-08-05 at 09:00.');
  });

  it('doctorNotification renders each event with its label', () => {
    for (const event of Object.keys(NOTIFY_EVENT_LABELS)) {
      const text = doctorNotification({ event, tokenNo: APPT.tokenNo, patientName: 'Ali', patientPhone: '+923001234567', date: APPT.date, time: APPT.time, reason: APPT.reason });
      assert.ok(text.includes(NOTIFY_EVENT_LABELS[event]), `labels ${event}`);
      assert.ok(text.includes(`Token #${APPT.tokenNo}`));
      assert.ok(text.includes('Ali (+923001234567)'));
      assert.ok(text.includes(`${APPT.date} ${APPT.time}.`));
      assert.ok(text.includes('Reason: fever'));
    }
  });

  it('doctorNotification falls back to "New booking" for an unknown event', () => {
    const text = doctorNotification({ event: 'wat', tokenNo: 1, patientName: 'Ali', patientPhone: '+923001234567', date: APPT.date, time: APPT.time });
    assert.ok(text.includes('New booking: Token #1'));
  });

  it('doctorNotification and patientConfirmation are distinguishable bodies (dedupe relies on exact match)', () => {
    const doctorText = doctorNotification({ event: 'booked', tokenNo: 42, patientName: 'Ali', patientPhone: '+923001234567', date: APPT.date, time: APPT.time });
    const patientText = patientConfirmation(APPT);
    assert.notEqual(doctorText, patientText, 'doctor vs patient templates never collide');
  });
});
