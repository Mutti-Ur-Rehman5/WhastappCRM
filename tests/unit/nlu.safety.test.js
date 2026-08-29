// Fast-CI safety regression for the Phase 3 NLU → orchestrator pipeline
// (RULES.md §2 / requirement 5). These run WITHOUT Gemini — they prove that
// even when NLU over-extracts (e.g. an over-eager model invents a date/time),
// the orchestrator slot-filler still asks for every field the patient never
// actually supplied, so a silent wrong booking is impossible.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  missingBookingFields,
  nextStateForBook,
  BOOK_FIELD_STATES,
} from '../../src/orchestrator/stateMachine.js';
import { handleBookIntent } from '../../src/orchestrator/intents/book.intent.js';
import { mergeSlots } from '../../src/services/conversation.memory.service.js';
import { understandMessage } from '../../src/services/nlu.service.js';
import { closeRedis } from '../../src/config/redis.js';
import { closeInboundQueue } from '../../src/queues/inboundMessage.queue.js';
import { closeSheetsQueues } from '../../src/queues/sheetsSync.queue.js';
import { closeNotifyDoctorQueues } from '../../src/queues/notifyDoctor.queue.js';
import { closeNotifyPatientQueue } from '../../src/queues/notifyPatient.queue.js';
import { closeRemindersQueues } from '../../src/queues/reminders.queue.js';

// Module imports open Redis/BullMQ connections (the same ones the integration
// suites tear down) — release them so `node --test` can exit.
after(async () => {
  await closeInboundQueue();
  await closeSheetsQueues();
  await closeNotifyDoctorQueues();
  await closeNotifyPatientQueue();
  await closeRemindersQueues();
  await closeRedis();
});

const functionCall = (name, args) => ({
  candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
});

// Fake gemini whose model returns the canned function call — lets us drive
// understandMessage through an "over-eager model" without any network call.
// generateContent returns the response object directly (the SDK returns it
// as `.response`; understandMessage reads `result.response.candidates`).
function cannedGemini(call) {
  return {
    getGenerativeModel() {
      return {
        async generateContent() {
          return { response: call };
        },
      };
    },
  };
}

const fakeBreaker = {
  name: 'mock',
  async fire({ modelHandle, contents }) {
    // Mirrors the real callGemini: generateContent returns a result whose
    // `.response` is the actual GenerateContentResponse extractToolCall reads.
    const result = await modelHandle.generateContent({ contents });
    return result.response;
  },
};

const SEEDED_SLOTS = { phone: '+923001234567' };

describe('missingBookingFields / nextStateForBook (DESIGN.md §6)', () => {
  it('reports every missing book field in question order (phone is never a required field)', () => {
    assert.deepEqual(missingBookingFields({}), ['name', 'reason']);
    assert.deepEqual(missingBookingFields({ phone: '+92' }), ['name', 'reason']);
    assert.deepEqual(missingBookingFields({ phone: '+92', name: 'A', reason: 'fever' }), []);
    assert.deepEqual(
      missingBookingFields({ phone: '+92', name: 'A', reason: 'fever', date: '2026-08-02', time: '17:00' }),
      [],
    );
  });

  it('maps missing fields to the correct COLLECTING_* state', () => {
    assert.equal(nextStateForBook({}), BOOK_FIELD_STATES.name);
    assert.equal(nextStateForBook({ phone: '+92' }), BOOK_FIELD_STATES.name);
    assert.equal(nextStateForBook({ phone: '+92', name: 'A' }), BOOK_FIELD_STATES.reason);
    assert.equal(nextStateForBook({ phone: '+92', name: 'A', reason: 'x' }), 'AWAITING_CONFIRMATION');
    assert.equal(nextStateForBook({ phone: '+92', name: 'A', reason: 'x', date: '2026-08-02', time: '17:00' }), 'AWAITING_CONFIRMATION');
  });
});

describe('handleBookIntent never silently books (RULES.md §2)', () => {
  it('asks for name when only a (possibly invented) date/time is present', () => {
    const result = handleBookIntent({ conv: { slots: SEEDED_SLOTS }, input: { date: '2026-08-02', time: '17:00' } });
    assert.notEqual(result.nextState, 'AWAITING_CONFIRMATION');
    assert.equal(result.nextState, BOOK_FIELD_STATES.name);
    assert.deepEqual(result.missing, ['name', 'reason']);
    assert.match(result.reply, /name/i);
  });

  it('asks for the reason when name+phone+datetime are present but reason is absent', () => {
    const result = handleBookIntent({
      conv: { slots: SEEDED_SLOTS },
      input: { date: '2026-08-02', time: '17:00', name: 'Ahmed' },
    });
    assert.equal(result.nextState, BOOK_FIELD_STATES.reason);
    assert.deepEqual(result.missing, ['reason']);
  });

  it('reaches AWAITING_CONFIRMATION ONLY when every field is patient-supplied', () => {
    const result = handleBookIntent({
      conv: { slots: SEEDED_SLOTS },
      input: { date: '2026-08-02', time: '17:00', name: 'Ahmed', reason: 'fever' },
    });
    assert.equal(result.nextState, 'AWAITING_CONFIRMATION');
    assert.deepEqual(result.missing, []);
  });

  it('an empty extraction still asks a question (never confirms)', () => {
    const result = handleBookIntent({ conv: { slots: SEEDED_SLOTS }, input: {} });
    assert.notEqual(result.nextState, 'AWAITING_CONFIRMATION');
    assert.deepEqual(result.missing, ['name', 'reason']);
  });
});

describe('mergeSlots never invents a value (MEMORY.md §3.5)', () => {
  it('null/undefined/"" never overwrite an already-collected field', () => {
    const merged = mergeSlots({ phone: '+92', date: '2026-08-02' }, { date: null, time: undefined, name: '' });
    assert.deepEqual(merged, { phone: '+92', date: '2026-08-02' });
  });

  it('real values do fill fields', () => {
    const merged = mergeSlots({ phone: '+92' }, { date: '2026-08-02', time: '17:00' });
    assert.equal(merged.date, '2026-08-02');
    assert.equal(merged.time, '17:00');
  });
});

describe('NLU → orchestrator chain: over-eager model cannot cause a silent booking', () => {
  it('an invented date/time for "appointment chahiye" still ends in a follow-up question', async () => {
    const result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: 'appointment chahiye' }],
      slots: {},
      todayRef: '2026-08-01',
      gemini: cannedGemini(functionCall('book_appointment', { date: '2026-08-02', time: '17:00' })),
      breaker: fakeBreaker,
      model: 'mock-model',
    });

    assert.equal(result.toolCall.name, 'book_appointment');
    // Even though the mock model invented a full date+time, the orchestrator
    // still needs name + reason, which the patient never gave → follow-up.
    const next = handleBookIntent({ conv: { slots: SEEDED_SLOTS }, input: result.toolCall.input });
    assert.notEqual(next.nextState, 'AWAITING_CONFIRMATION');
    assert.equal(next.nextState, BOOK_FIELD_STATES.name);
    assert.match(next.reply, /name/i);
  });

  it('an invented date+time+reason still cannot confirm without the name', async () => {
    const result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: 'kal 5 baje chahiye' }],
      slots: {},
      todayRef: '2026-08-01',
      gemini: cannedGemini(
        functionCall('book_appointment', { date: '2026-08-02', time: '17:00', reason: 'fever' }),
      ),
      breaker: fakeBreaker,
      model: 'mock-model',
    });
    const next = handleBookIntent({ conv: { slots: SEEDED_SLOTS }, input: result.toolCall.input });
    assert.notEqual(next.nextState, 'AWAITING_CONFIRMATION');
    assert.equal(next.nextState, BOOK_FIELD_STATES.name);
  });
});
