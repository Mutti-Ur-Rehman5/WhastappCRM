import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { app } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { redis } from '../../src/config/redis.js';
import { AuditLog } from '../../src/models/AuditLog.model.js';
import { Conversation } from '../../src/models/Conversation.model.js';
import { MessageLog } from '../../src/models/MessageLog.model.js';
import {
  createInboundWorker,
  closeInboundQueue,
  getInboundQueue,
} from '../../src/queues/inboundMessage.queue.js';
import { _setAudioDeps } from '../../src/webhooks/whatsapp.webhook.js';
import { AUDIO_FALLBACK_REPLY } from '../../src/services/audioUnderstanding.service.js';
import { convKey } from '../../src/services/conversation.memory.service.js';
import { todayInClinicTimeZone } from '../../src/utils/datetime.util.js';

// ---------------------------------------------------------------- helpers ---

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, { timeout = 10000, interval = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await cond();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const sign = (body) => `sha256=${crypto.createHmac('sha256', env.whatsapp.appSecret).update(body).digest('hex')}`;

// Unique per process-run: custom BullMQ jobIds (= waMessageId) persist in the
// queue's completed set, so reusing fixed wamids across runs silently no-ops
// the enqueue. Same idempotency trick as tests/unit/models.test.js.
const RUN_DIGITS = Date.now().toString().slice(-8);
const wamid = (tag) => `wamid.${tag}.${RUN_DIGITS}`;

const WID_TEST1 = wamid('in.test1');
const WID_TEST2 = wamid('in.test2');
const WID_TEST3 = wamid('in.test3');
const WID_ORDER = (i) => wamid(`in.order${i}`);
const WID_CONC = (tag) => wamid(`in.conc.${tag}`);
const WID_AUDIO_OK = wamid('in.audio.ok');
const WID_AUDIO_FAIL = wamid('in.audio.fail');

const webhookBody = (from, text, waMessageId, type = 'text') => {
  const message =
    type === 'audio'
      ? {
          from,
          id: waMessageId,
          timestamp: '1700000000',
          type,
          audio: { id: `media.${RUN_DIGITS}`, mime_type: 'audio/ogg; codecs=opus', voice: true },
        }
      : { from, id: waMessageId, timestamp: '1700000000', type, text: { body: text } };
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'test-ba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15551234567', phone_number_id: env.whatsapp.phoneNumberId },
              messages: [message],
            },
          },
        ],
      },
    ],
  });
};

// Mocked WhatsApp outbound (RULES.md §7: tests never hit the real API).
const sendCalls = [];
const activeByPhone = {};
const maxActiveByPhone = {};
let maxActive = 0;
let mockDelayMs = 0;
// Always-increasing counter (independent of sendCalls.length resets) so the
// fake outbound ids never collide with the MessageLog unique index.
let mockOutboundSeq = 0;

// Voice turns reply via sendVoiceMessage (TTS pipeline). Tests stub it so the
// orchestrator's default (real Gemini + ffmpeg + WhatsApp) is never touched.
const voiceSendCalls = [];
async function mockSendVoiceMessage({ to, text }) {
  mockOutboundSeq += 1;
  voiceSendCalls.push({ to, text, at: Date.now() });
  return `wamid.out.voice.${mockOutboundSeq}`;
}

// The orchestrator (Phase 3) replaced the static stub reply. These webhook
// tests mock the NLU to a canned smalltalk reply so the end-to-end plumbing
// assertions stay deterministic — the NLU itself is covered in nlu.service
// and orchestrator tests.
const STATIC_REPLY = "hello, I'm the clinic assistant";
// Captures the args the worker hands to NLU so the voice test can assert that
// the raw audio media reaches the NLU call (not a transcript).
const nluCalls = [];
const mockNlu = async (args) => {
  nluCalls.push(args);
  return {
    toolCall: { name: 'smalltalk_or_unclear', input: { replyHint: STATIC_REPLY } },
  };
};

async function mockSendMessage({ to, text }) {
  activeByPhone[to] = (activeByPhone[to] || 0) + 1;
  maxActiveByPhone[to] = Math.max(maxActiveByPhone[to] || 0, activeByPhone[to]);
  const activeNow = Object.values(activeByPhone).reduce((sum, n) => sum + n, 0);
  maxActive = Math.max(maxActive, activeNow);
  try {
    if (mockDelayMs > 0) await sleep(mockDelayMs);
    sendCalls.push({ to, text, at: Date.now() });
    mockOutboundSeq += 1;
    return `wamid.out.${mockOutboundSeq}`;
  } finally {
    activeByPhone[to] -= 1;
  }
}

let server;
let baseUrl;
let worker;

// ------------------------------------------------------------------ setup ---

before(async () => {
  await connectTestDb();
  await MessageLog.deleteMany({});
  await Conversation.deleteMany({});
  await AuditLog.deleteMany({});
  // Wipe the whole queue, not just drain(): a previous run that crashed while
  // jobs were stuck (e.g. lock-wait timeouts) leaves jobs in waiting/delayed
  // state that drain() may not clear; this run's worker would then reprocess
  // them and pollute sendCalls / MessageLog for the ordering assertions.
  await getInboundQueue().obliterate({ force: true }).catch(() => {});
  worker = createInboundWorker({
    sendMessage: mockSendMessage,
    sendVoiceMessage: mockSendVoiceMessage,
    nlu: mockNlu,
    todayRef: todayInClinicTimeZone(),
  });
  server = app.listen(0);
  await waitFor(() => server.listening, { label: 'server listening' });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  _setAudioDeps({});
  await worker.close();
  await closeInboundQueue();
  await new Promise((resolve) => server.close(resolve));
  await closeTestDb();
  await redis.quit();
});

// ------------------------------------------------------------------ tests ---

describe('WhatsApp webhook integration (mocked send)', () => {
  it('GET verification handshake succeeds with the right token', async () => {
    const url = `${baseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${env.whatsapp.verifyToken}&hub.challenge=CHALLENGE_123`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'CHALLENGE_123');
  });

  it('GET verification handshake is rejected with a wrong token', async () => {
    const url = `${baseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHALLENGE_123`;
    const res = await fetch(url);
    assert.equal(res.status, 403);
  });

  it('acks a valid text message, dedupes by waMessageId, and replies with the static message', async () => {
    const body = webhookBody('923001234567', 'hi doctor', WID_TEST1, 'text');

    const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      body,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });

    const inbound = await waitFor(
      () => MessageLog.findOne({ waMessageId: WID_TEST1, direction: 'in' }),
      { label: 'inbound MessageLog record' },
    );
    assert.equal(inbound.phone, '+923001234567');
    assert.equal(inbound.body, 'hi doctor');
    assert.equal(inbound.channel, 'whatsapp');

    await waitFor(
      () => MessageLog.exists({ refWaMessageId: WID_TEST1, direction: 'out' }),
      { label: 'outbound reply record' },
    );
    assert.equal(sendCalls.at(-1).to, '+923001234567');
    assert.equal(sendCalls.at(-1).text, STATIC_REPLY);
  });

  it('ignores a redelivered duplicate message (same waMessageId)', async () => {
    const sendsBefore = sendCalls.length;
    const body = webhookBody('923001234567', 'hi doctor', WID_TEST1, 'text');

    const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      body,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', duplicate: true });

    await sleep(150);
    assert.equal(sendCalls.length, sendsBefore, 'duplicate must not trigger another send');
    assert.equal(await MessageLog.countDocuments({ waMessageId: WID_TEST1 }), 1);
  });

  it('rejects an invalid signature with 401 and processes nothing', async () => {
    const body = webhookBody('923001234568', 'unauthorized attempt', WID_TEST2, 'text');
    const tampered = webhookBody('923001234568', 'unauthorized attempt', WID_TEST2, 'text').replace('attempt', 'attemPt');

    const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(tampered) },
      body,
    });
    assert.equal(res.status, 401);

    await sleep(150);
    assert.equal(await MessageLog.exists({ waMessageId: WID_TEST2 }), null, 'no record for unverified request');
    assert.ok(!sendCalls.some((c) => c.to === '+923001234568'), 'no reply for unverified request');
  });

  it('acks but ignores non-text messages', async () => {
    const body = webhookBody('923001234569', undefined, WID_TEST3, 'image');

    const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      body,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });

    await sleep(150);
    assert.equal(await MessageLog.exists({ waMessageId: WID_TEST3 }), null);
    assert.ok(!sendCalls.some((c) => c.to === '+923001234569'));
  });

  it('downloads a voice note, enqueues the RAW audio, and the worker hands it to NLU (reply via the same pipeline)', async () => {
    const audioPayload = { mimeType: 'audio/ogg', data: Buffer.from('fake-audio-bytes').toString('base64') };
    const nluBefore = nluCalls.length;
    _setAudioDeps({ fetchAudioPayload: async () => audioPayload });
    try {
      const phone = '923001234570';
      const body = webhookBody(phone, undefined, WID_AUDIO_OK, 'audio');

      const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
        body,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });

      // The worker understood the note by handing the raw audio bytes to the
      // NLU call as `media` (no separate transcription step, no transcript text).
      const nluArgs = await waitFor(() => {
        const call = nluCalls[nluCalls.length - 1];
        return call?.media ? call : undefined;
      }, { label: 'NLU call carrying the raw audio media' });
      assert.deepEqual(nluArgs.media, audioPayload);

      // The inbound record uses a marker body (audio bytes are never persisted).
      const inbound = await waitFor(
        () => MessageLog.findOne({ waMessageId: WID_AUDIO_OK, direction: 'in' }),
        { label: 'audio inbound MessageLog record' },
      );
      assert.equal(inbound.phone, '+923001234570');
      assert.equal(inbound.body, '[voice note]');

      await waitFor(
        () => MessageLog.exists({ refWaMessageId: WID_AUDIO_OK, direction: 'out' }),
        { label: 'audio outbound reply record' },
      );
      // The reply goes through the VOICE channel (voice-in → voice-out), never
      // the plain-text path.
      await waitFor(() => voiceSendCalls.some((c) => c.to === '+923001234570'), { label: 'voice outbound reply' });
      assert.equal(voiceSendCalls.at(-1).to, '+923001234570');
      assert.equal(voiceSendCalls.at(-1).text, STATIC_REPLY);
      assert.ok(nluCalls.length > nluBefore, 'NLU was called for the audio turn');
    } finally {
      _setAudioDeps({});
    }
  });

  it('replies with a graceful text when a voice note cannot be downloaded, and dedupes it', async () => {
    _setAudioDeps({
      fetchAudioPayload: async () => {
        throw new Error('Media API download failed');
      },
      sendTextMessage: mockSendMessage,
    });
    try {
      const phone = '923001234571';
      const sendsBefore = sendCalls.length;
      const body = webhookBody(phone, undefined, WID_AUDIO_FAIL, 'audio');

      const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
        body,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });

      const outbound = await waitFor(
        () => MessageLog.findOne({ refWaMessageId: WID_AUDIO_FAIL, direction: 'out' }),
        { label: 'audio fallback outbound record' },
      );
      assert.equal(outbound.body, AUDIO_FALLBACK_REPLY);
      assert.equal(sendCalls.at(-1).to, '+923001234571');
      assert.equal(sendCalls.at(-1).text, AUDIO_FALLBACK_REPLY);

      const inbound = await MessageLog.findOne({ waMessageId: WID_AUDIO_FAIL, direction: 'in' });
      assert.equal(inbound.body, AUDIO_FALLBACK_REPLY);

      // Redelivery of the same audio message must not trigger a second reply.
      const res2 = await fetch(`${baseUrl}/webhook/whatsapp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
        body,
      });
      assert.deepEqual(await res2.json(), { status: 'ok', duplicate: true });
      await sleep(150);
      assert.equal(sendCalls.length, sendsBefore + 1, 'fallback reply sent exactly once');
    } finally {
      _setAudioDeps({});
    }
  });

  it('processes a phone rapid-fire messages strictly in order', async () => {
    sendCalls.length = 0;
    mockDelayMs = 80;
    try {
      const phone = '923001234561';
      const order = ['first', 'second', 'third'];
      for (let i = 0; i < order.length; i += 1) {
        const body = webhookBody(phone, order[i], WID_ORDER(i + 1), 'text');
        const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
          body,
        });
        assert.equal(res.status, 200);
      }

      // Both the sends AND their persisted outbound records must be visible
      // before asserting, otherwise the 3rd record can still be in flight.
      await waitFor(async () => {
        if (sendCalls.length < 3) return false;
        const n = await MessageLog.countDocuments({ direction: 'out', refWaMessageId: /wamid.in.order/ });
        return n === 3;
      }, { label: '3 ordered replies sent and persisted' });

      // Reply order must equal enqueue order — proven via the persisted outbound
      // records whose refWaMessageId links each reply to its inbound message.
      const outbound = await MessageLog.find({ direction: 'out', refWaMessageId: /wamid.in.order/ })
        .sort({ ts: 1 })
        .lean();
      assert.deepEqual(
        outbound.map((o) => o.refWaMessageId),
        [WID_ORDER(1), WID_ORDER(2), WID_ORDER(3)],
        'per-phone replies must be sent FIFO',
      );
      assert.equal(activeByPhone['+923001234561'], 0);
      assert.equal(maxActiveByPhone['+923001234561'], 1, 'same-phone jobs must never overlap');
    } finally {
      mockDelayMs = 0;
    }
  });

  it('processes different phones concurrently while keeping each phone serialized', async () => {
    sendCalls.length = 0;
    maxActive = 0;
    for (const key of Object.keys(maxActiveByPhone)) delete maxActiveByPhone[key];
    mockDelayMs = 100;
    try {
      const bodies = [
        webhookBody('923001234562', 'a1', WID_CONC('a1'), 'text'),
        webhookBody('923001234562', 'a2', WID_CONC('a2'), 'text'),
        webhookBody('923001234563', 'b1', WID_CONC('b1'), 'text'),
        webhookBody('923001234564', 'c1', WID_CONC('c1'), 'text'),
        webhookBody('923001234565', 'd1', WID_CONC('d1'), 'text'),
        webhookBody('923001234566', 'e1', WID_CONC('e1'), 'text'),
      ];
      for (const body of bodies) {
        const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
          body,
        });
        assert.equal(res.status, 200);
      }

      await waitFor(async () => {
        if (sendCalls.length < bodies.length) return false;
        const n = await MessageLog.countDocuments({ direction: 'out', refWaMessageId: /wamid.in.conc.a/ });
        return n === 2;
      }, { label: 'all concurrent replies sent and persisted' });

      assert.ok(maxActive >= 2, `expected >=2 phones in flight concurrently, saw ${maxActive}`);
      assert.equal(activeByPhone['+923001234562'], 0, 'phone A must finish serialized');
      assert.equal(maxActiveByPhone['+923001234562'], 1, 'phone A jobs must never overlap');
      const outboundA = await MessageLog.find({ direction: 'out', refWaMessageId: /wamid.in.conc.a/ })
        .sort({ ts: 1 })
        .lean();
      assert.deepEqual(
        outboundA.map((o) => o.refWaMessageId),
        [WID_CONC('a1'), WID_CONC('a2')],
        'same-phone replies stay in order under concurrency',
      );
    } finally {
      mockDelayMs = 0;
    }
  });
});
