import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import { connectTestDb, closeTestDb } from '../../helpers/db.js';
import { redis } from '../../../src/config/redis.js';
import { DoctorConfig } from '../../../src/models/DoctorConfig.model.js';
import { MessageLog } from '../../../src/models/MessageLog.model.js';
import { Conversation } from '../../../src/models/Conversation.model.js';
import { handleInbound, UNCLEAR_REPLY } from '../../../src/orchestrator/conversation.orchestrator.js';
import { understandMessage, getGeminiBreaker, _resetGeminiBreaker } from '../../../src/services/nlu.service.js';
import { makeDoctorConfig } from '../load/helpers.js';
import { invalidateDoctorConfigCache } from '../../../src/services/slot.service.js';

// DESIGN.md §10: "Gemini fail → retry once → rule-based fallback or a friendly
// sorry-reply". The breaker + fallback parser are the resilience layer: an
// outage must NOT hang the worker, error the turn, or break the bot for simple
// requests. This is chaos-injected through the REAL singleton breaker with a
// gemini client that fails like a live outage (RULES.md §7 mocks the client,
// not the breaker/fallback logic).

const PHONE = '+923099123001';
const TODAY = '2099-08-01';

function makeFailingGemini() {
  return {
    getGenerativeModel: () => ({
      generateContent: async () => {
        const err = new Error('Gemini API outage (chaos)');
        err.status = 500;
        throw err;
      },
    }),
  };
}

let config;

before(async () => {
  await connectTestDb();
  await DoctorConfig.deleteMany({ doctorName: 'gemini-chaos.config' });
  await Conversation.deleteMany({ phone: PHONE });
  await MessageLog.deleteMany({ phone: PHONE });
  _resetGeminiBreaker();
  config = await makeDoctorConfig({ doctorName: 'gemini-chaos.config', doctorPhone: '+923001239981' });
  await invalidateDoctorConfigCache();
});

after(async () => {
  _resetGeminiBreaker();
  await Conversation.deleteMany({ phone: PHONE });
  await MessageLog.deleteMany({ phone: PHONE });
  await DoctorConfig.deleteMany({ doctorName: 'gemini-chaos.config' });
  await closeTestDb();
  await redis.quit();
});

describe('chaos: Gemini outage → circuit breaker → fallback parser (DESIGN.md §10)', () => {
  it('a simple booking request is still understood via the fallback parser, not "did not understand"', async () => {
    const result = await handleInbound(
      { phone: PHONE, text: 'book appointment tomorrow at 3pm', waMessageId: 'gemini-chaos-turn-1' },
      {
        nlu: (args) => understandMessage({ ...args, gemini: makeFailingGemini() }),
        sendMessage: async () => 'gemini-chaos-out-1',
        todayRef: TODAY,
        doctorConfig: config,
      },
    );

    assert.equal(result.intent, 'book');
    assert.equal(result.toolCall.name, 'book_appointment');
    assert.equal(result.toolCall.input.date, dayjs(`${TODAY}T00:00:00`).add(1, 'day').format('YYYY-MM-DD'));
    assert.equal(result.toolCall.input.time, '15:00');
    assert.match(result.reply, /naam|name/i);
    assert.notEqual(result.reply, UNCLEAR_REPLY);
    assert.equal(result.state, 'COLLECTING_NAME');
  });

  it('repeated failures trip the breaker OPEN, then calls fail fast through the fallback', async () => {
    const gemini = makeFailingGemini();
    const breaker = getGeminiBreaker();

    for (let i = 0; i < 6; i += 1) {
      await understandMessage({
        phone: PHONE,
        history: [{ role: 'user', text: 'book 12-08-2099 4pm' }],
        slots: {},
        todayRef: TODAY,
        gemini,
      });
    }
    assert.equal(breaker.opened, true, 'breaker must trip OPEN after 5+ consecutive failures');

    // While OPEN the breaker rejects instantly (fail fast); understandMessage
    // must NOT throw and must still produce a parseable tool call.
    const result = await understandMessage({
      phone: PHONE,
      history: [{ role: 'user', text: 'book appointment 12-08-2099 at 4pm' }],
      slots: {},
      todayRef: TODAY,
      gemini,
    });
    assert.equal(result.source, 'fallback');
    assert.equal(result.toolCall.name, 'book_appointment');
    assert.equal(result.toolCall.input.date, '2099-08-12');
    assert.equal(result.toolCall.input.time, '16:00');
  });
});
