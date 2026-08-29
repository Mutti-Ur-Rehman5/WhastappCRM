import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFallback,
  parseConfirmation,
  extractDate,
  extractTime,
  FALLBACK_UNREPLIED_HINT,
  FALLBACK_MENU_REPLY,
  FALLBACK_GREETING_REPLY,
  FALLBACK_PHONE_REPROMPT,
} from '../../src/services/fallbackParser.service.js';

// Rule-based fallback parser (DESIGN.md §10): deterministic date/time/keyword
// extraction used when the Gemini circuit breaker is open.

const TODAY = '2026-08-01';

describe('extractDate', () => {
  it('parses ISO YYYY-MM-DD', () => {
    assert.equal(extractDate('2026-08-05', TODAY), '2026-08-05');
  });

  it('parses day-first DD-MM-YYYY and DD/MM/YYYY', () => {
    assert.equal(extractDate('05-08-2026', TODAY), '2026-08-05');
    assert.equal(extractDate('5/8/2026', TODAY), '2026-08-05');
  });

  it('swaps an unambiguous month-first date (05-13-2026 → 2026-05-13)', () => {
    assert.equal(extractDate('05-13-2026', TODAY), '2026-05-13');
    assert.equal(extractDate('13-05-2026', TODAY), '2026-05-13');
  });

  it('parses "5 August" and "5th Aug 2026"', () => {
    assert.equal(extractDate('5 August', TODAY), '2026-08-05');
    assert.equal(extractDate('5th Aug 2026', TODAY), '2026-08-05');
  });

  it('resolves relative words against todayRef (not the LLM)', () => {
    assert.equal(extractDate('aaj', TODAY), TODAY);
    assert.equal(extractDate('today', TODAY), TODAY);
    assert.equal(extractDate('kal', TODAY), '2026-08-02');
    assert.equal(extractDate('tomorrow', TODAY), '2026-08-02');
    assert.equal(extractDate('parson', TODAY), '2026-08-03');
    assert.equal(extractDate('day after tomorrow', TODAY), '2026-08-03');
  });

  it('resolves a named weekday to its next occurrence strictly after today', () => {
    // TODAY = 2026-08-01 (Saturday).
    assert.equal(extractDate('Wednesday ko 5 baje', TODAY), '2026-08-05');
    assert.equal(extractDate('Monday ko', TODAY), '2026-08-03');
    assert.equal(extractDate('Saturday ko', TODAY), '2026-08-08'); // same day → next week
  });

  it('returns null when no date is present', () => {
    assert.equal(extractDate('book an appointment please', TODAY), null);
  });
});

describe('extractTime', () => {
  it('parses 24h times', () => {
    assert.equal(extractTime('17:00'), '17:00');
    assert.equal(extractTime('09:30'), '09:30');
  });

  it('parses 12h with meridiem', () => {
    assert.equal(extractTime('5:30pm'), '17:30');
    assert.equal(extractTime('5 pm'), '17:00');
    assert.equal(extractTime('12am'), '00:00');
    assert.equal(extractTime('12 pm'), '12:00');
  });

  it('parses Roman Urdu period + baje', () => {
    assert.equal(extractTime('shaam 5 baje'), '17:00');
    assert.equal(extractTime('raat 9 baje'), '21:00');
    assert.equal(extractTime('dopehar 2 baje'), '14:00');
    assert.equal(extractTime('shaam ko'), '18:00');
  });

  it('parses a bare "N baje" without a period word (Gemini convention)', () => {
    assert.equal(extractTime('5 baje'), '17:00');
    assert.equal(extractTime('kal 5 bajy'), '17:00');
    assert.equal(extractTime('9 baje'), '09:00');
    assert.equal(extractTime('2 baje'), '14:00');
  });

  it('returns null for non-time text', () => {
    assert.equal(extractTime('no time mentioned'), null);
  });
});

describe('parseFallback', () => {
  it('maps a book request with date+time to book_appointment', () => {
    const result = parseFallback({ text: 'book 2026-08-05 at 17:00', todayRef: TODAY });
    assert.deepEqual(result, { name: 'book_appointment', input: { date: '2026-08-05', time: '17:00' } });
  });

  it('regression: a date/time beats the generic "appointment" query keyword', () => {
    const result = parseFallback({ text: 'book appointment tomorrow at 3pm', todayRef: TODAY });
    assert.deepEqual(result, { name: 'book_appointment', input: { date: '2026-08-02', time: '15:00' } });
  });

  it('regression: an explicit book request is NOT swallowed by the query keyword (the outage bug)', () => {
    for (const text of [
      'Mujy appointment book karne ha',
      'Doctor ky sath appointment book karne ha',
      'nayi appointment',
      'appointment chahiye',
      'doctor sy milna ha',
    ]) {
      const result = parseFallback({ text, todayRef: TODAY });
      assert.equal(result.name, 'book_appointment', `expected book_appointment for "${text}"`);
    }
  });

  it('regression: "mera appointment kab hai" still routes to the query', () => {
    const result = parseFallback({ text: 'mera appointment kab hai?', todayRef: TODAY });
    assert.equal(result.name, 'query_my_appointments');
  });

  it('parses "Kal Wednesday ko 5 bajy" into date + time (the live outage flow)', () => {
    const result = parseFallback({ text: 'Kal Wednesday ko 5 bajy', todayRef: '2026-08-04' });
    assert.deepEqual(result, { name: 'book_appointment', input: { date: '2026-08-05', time: '17:00' } });
  });

  it('maps a cancel request to cancel_appointment', () => {
    const result = parseFallback({ text: 'cancel my appointment', todayRef: TODAY });
    assert.equal(result.name, 'cancel_appointment');
  });

  it('maps a reschedule request to reschedule_appointment with newDate/newTime', () => {
    const result = parseFallback({ text: 'reschedule to kal 3pm', todayRef: TODAY });
    assert.deepEqual(result, { name: 'reschedule_appointment', input: { newDate: '2026-08-02', newTime: '15:00' } });
  });

  it('maps an appointment query to query_my_appointments', () => {
    const result = parseFallback({ text: 'mera appointment kab hai?', todayRef: TODAY });
    assert.equal(result.name, 'query_my_appointments');
  });

  it('maps an availability question to check_availability', () => {
    const result = parseFallback({ text: 'are there free slots on 05-08-2026', todayRef: TODAY });
    assert.equal(result.name, 'check_availability');
  });

  it('falls back to smalltalk_or_unclear for unparseable text', () => {
    const result = parseFallback({ text: 'zzz qqq', todayRef: TODAY });
    assert.deepEqual(result, { name: 'smalltalk_or_unclear', input: { replyHint: FALLBACK_UNREPLIED_HINT } });
  });

  it('empty text never throws', () => {
    const result = parseFallback({ text: '   ', todayRef: TODAY });
    assert.equal(result.name, 'smalltalk_or_unclear');
  });

  it('maps MENU to the menu reply instead of a dead end', () => {
    const result = parseFallback({ text: 'MENU', todayRef: TODAY });
    assert.deepEqual(result, { name: 'smalltalk_or_unclear', input: { replyHint: FALLBACK_MENU_REPLY } });
  });

  describe('greeting detection (Gemini-down smalltalk)', () => {
    for (const greeting of ['Aoa', 'AOA', 'assalam o alaikum', 'Salam', 'hello', 'Hi', 'good morning', 'subah bakhair']) {
      it(`greets ${JSON.stringify(greeting)} instead of bouncing a sorry`, () => {
        const result = parseFallback({ text: greeting, todayRef: TODAY });
        assert.deepEqual(result, { name: 'smalltalk_or_unclear', input: { replyHint: FALLBACK_GREETING_REPLY } });
      });
    }

    it('greeting words do not shadow later booking/query keywords', () => {
      const result = parseFallback({ text: 'mera appointment kab hai', todayRef: TODAY });
      assert.equal(result.name, 'query_my_appointments');
    });

    // BUG-2 regression: a complete one-shot booking message that OPENS with a
    // greeting must be booked, not answered with "How can I help you?" (the
    // greeting branch used to swallow the whole message).
    it('greeting + full booking in ONE message books the date/time instead of greeting', () => {
      const result = parseFallback({
        text: 'Assalam o Alaikum, mera naam Ahmed Raza hai, sar mein dard hai, kal shaam 5 baje aana hai',
        todayRef: TODAY,
      });
      assert.equal(result.name, 'book_appointment');
      assert.equal(result.input.date, '2026-08-02');
      assert.equal(result.input.time, '17:00');
    });

    it('greeting + "book ... tomorrow at 3pm" books, not greets (English one-shot)', () => {
      const result = parseFallback({ text: 'hello doctor, my name is Ali, i have fever, book me tomorrow at 3pm', todayRef: TODAY });
      assert.equal(result.name, 'book_appointment');
      assert.equal(result.input.date, '2026-08-02');
      assert.equal(result.input.time, '15:00');
    });

    it('greeting + cancel is a cancel, not smalltalk', () => {
      const result = parseFallback({ text: 'Aoa, mera appointment cancel karna hai', todayRef: TODAY });
      assert.equal(result.name, 'cancel_appointment');
    });

    it('greeting + reschedule is a reschedule, not smalltalk', () => {
      const result = parseFallback({ text: 'Salam, appointment tabdeel karni hai', todayRef: TODAY });
      assert.equal(result.name, 'reschedule_appointment');
    });
  });
});

describe('parseFallback state-aware collection (DESIGN.md §10)', () => {
  it('COLLECTING_NAME accepts free text as the patient name', () => {
    const result = parseFallback({ text: 'Mera nam mutti Ur Rehman ha', todayRef: TODAY, state: 'COLLECTING_NAME' });
    assert.deepEqual(result, { name: 'book_appointment', input: { name: 'Mera nam mutti Ur Rehman ha' } });
  });

  it('COLLECTING_REASON accepts free text as the visit reason (the outage bug)', () => {
    const result = parseFallback({ text: 'Bukhar ha mujy', todayRef: TODAY, state: 'COLLECTING_REASON' });
    assert.deepEqual(result, { name: 'book_appointment', input: { reason: 'Bukhar ha mujy' } });
  });

  it('COLLECTING_PHONE accepts a phone-looking answer', () => {
    const result = parseFallback({ text: '03001234567', todayRef: TODAY, state: 'COLLECTING_PHONE' });
    assert.deepEqual(result, { name: 'book_appointment', input: { phone: '03001234567' } });
  });

  it('COLLECTING_PHONE accepts an international-format number', () => {
    const result = parseFallback({ text: '+92 312 3456789', todayRef: TODAY, state: 'COLLECTING_PHONE' });
    assert.deepEqual(result, { name: 'book_appointment', input: { phone: '+92 312 3456789' } });
  });

  it('regression: an incomplete phone (034555754, 9 digits) gets a helpful re-prompt, not the generic sorry (the live outage bug)', () => {
    const result = parseFallback({ text: '034555754', todayRef: TODAY, state: 'COLLECTING_PHONE' });
    assert.deepEqual(result, { name: 'smalltalk_or_unclear', input: { replyHint: FALLBACK_PHONE_REPROMPT } });
  });

  it('COLLECTING_PHONE does not swallow a non-phone answer (stays smalltalk)', () => {
    const result = parseFallback({ text: 'hello', todayRef: TODAY, state: 'COLLECTING_PHONE' });
    assert.equal(result.name, 'smalltalk_or_unclear');
  });

  it('MENU still wins inside a collecting state (explicit escape hatch)', () => {
    const result = parseFallback({ text: 'MENU', todayRef: TODAY, state: 'COLLECTING_NAME' });
    assert.deepEqual(result, { name: 'smalltalk_or_unclear', input: { replyHint: FALLBACK_MENU_REPLY } });
  });

  it('no state means prior keyword behaviour is unchanged', () => {
    const result = parseFallback({ text: 'cancel my appointment', todayRef: TODAY });
    assert.equal(result.name, 'cancel_appointment');
  });
});

describe('parseConfirmation', () => {
  it('returns true for English yes words', () => {
    for (const t of ['Yes', 'YES', 'yeah', 'yep', 'ok', 'okay']) {
      assert.equal(parseConfirmation(t), true, t);
    }
  });

  it('returns true for Roman Urdu yes words', () => {
    for (const t of ['haan', 'han', 'ha', 'ji', 'jee', 'theek hai', 'theek ha', 'theek haan', 'sahi', 'confirm']) {
      assert.equal(parseConfirmation(t), true, t);
    }
  });

  it('returns false for English/Roman Urdu no words', () => {
    for (const t of ['No', 'NO', 'nope', 'nahi', 'nahin', 'naheen', 'mat karo', 'theek nahi']) {
      assert.equal(parseConfirmation(t), false, t);
    }
  });

  it('does not match a word that merely starts with a yes/no word', () => {
    assert.equal(parseConfirmation('haan ji'), true); // still a yes
    assert.equal(parseConfirmation('haha'), null);
    assert.equal(parseConfirmation('nahi hoga'), false);
  });

  it('returns null for anything that is not a confirmation', () => {
    for (const t of ['kal 5 baje', 'appointment cancel karne ha', 'mera appointment kab hai', '']) {
      assert.equal(parseConfirmation(t), null, t);
    }
  });
});
