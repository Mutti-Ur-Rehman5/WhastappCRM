import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { redis } from '../../src/config/redis.js';
import { Conversation } from '../../src/models/Conversation.model.js';
import {
  appendAssistantTurn,
  appendUserTurn,
  CONV_IDLE_TIMEOUT_MS,
  convKey,
  HISTORY_MAX_TURNS,
  mergeSlots,
  persistConversation,
  readConversation,
} from '../../src/services/conversation.memory.service.js';

const PHONE = '+923001234501';

before(async () => {
  await connectTestDb();
  await Conversation.deleteMany({ phone: { $regex: '^\\+923001234' } });
  await redis.del(convKey(PHONE));
});

after(async () => {
  await closeTestDb();
  // This file imports the shared ioredis client (for the conv cache); quitting
  // lets the test process exit cleanly instead of hanging on the open socket.
  await redis.quit();
});

describe('readConversation (MEMORY.md §3.2 Redis-first, Mongo fallback)', () => {
  it('creates a fresh conversation on first contact, pre-seeding slots.phone from the sender id', async () => {
    const conv = await readConversation(PHONE);
    assert.equal(conv.phone, PHONE);
    assert.equal(conv.state, 'IDLE');
    assert.deepEqual(conv.slots, { phone: PHONE });
    assert.ok(conv._id, 'fresh conversations get a stable ObjectId for auditing');
  });

  it('serves subsequent reads from Redis without touching Mongo', async () => {
    const conv = await readConversation(PHONE);
    conv.slots.name = 'Only In Cache';
    await redis.set(convKey(PHONE), JSON.stringify(conv), 'EX', 1800);

    // Remove the Mongo doc — if we still read the cached name, we proved the
    // fast path hit Redis, not Mongo.
    await Conversation.deleteOne({ phone: PHONE });
    const cached = await readConversation(PHONE);
    assert.equal(cached.slots.name, 'Only In Cache');
  });

  it('falls back to Mongo and re-hydrates the cache after a miss', async () => {
    await redis.del(convKey(PHONE));
    await Conversation.findOneAndUpdate({ phone: PHONE }, { $set: { slots: { phone: PHONE, name: 'From Mongo' } } }, { upsert: true });

    const conv = await readConversation(PHONE);
    assert.equal(conv.slots.name, 'From Mongo');
    const cached = await redis.get(convKey(PHONE));
    assert.ok(cached && cached.includes('From Mongo'), 'cache must be re-hydrated on miss');
  });

  it('resets a stale conversation (idle past the timeout) to a fresh one — stale slots never leak into a new request', async () => {
    await redis.del(convKey(PHONE));
    await Conversation.findOneAndUpdate(
      { phone: PHONE },
      {
        $set: {
          state: 'AWAITING_CONFIRMATION',
          pendingIntent: 'book',
          slots: { phone: PHONE, name: 'Ali Usman', reason: 'sar mein dard', date: '2026-08-14', time: '13:00' },
          lastMessageAt: new Date(Date.now() - CONV_IDLE_TIMEOUT_MS - 1000),
        },
      },
      { upsert: true },
    );

    const conv = await readConversation(PHONE);
    assert.equal(conv.state, 'IDLE');
    assert.equal(conv.pendingIntent, null);
    assert.deepEqual(conv.history, [], 'history is discarded');
    assert.deepEqual(conv.slots, { phone: PHONE }, 'half-collected slots (name/reason/date/time) are discarded');
  });

  it('keeps a fresh conversation (recent lastMessageAt) intact', async () => {
    await redis.del(convKey(PHONE));
    await Conversation.findOneAndUpdate(
      { phone: PHONE },
      {
        $set: {
          state: 'COLLECTING_DATETIME',
          slots: { phone: PHONE, name: 'Ali' },
          lastMessageAt: new Date(),
        },
      },
      { upsert: true },
    );

    const conv = await readConversation(PHONE);
    assert.equal(conv.state, 'COLLECTING_DATETIME');
    assert.equal(conv.slots.name, 'Ali');
  });
});

describe('appendUserTurn / appendAssistantTurn (cap 20, evict oldest)', () => {
  it('appends and caps history at the last 20 turns', () => {
    const conv = { history: [] };
    for (let i = 1; i <= 25; i += 1) appendUserTurn(conv, `msg-${i}`);
    assert.equal(conv.history.length, HISTORY_MAX_TURNS);
    assert.equal(conv.history[0].text, 'msg-6', 'oldest turns are evicted');
    assert.equal(conv.history.at(-1).text, 'msg-25', 'newest turn is kept');
  });

  it('is idempotent per waMessageId (BullMQ at-least-once retry safety)', () => {
    const conv = { history: [] };
    assert.equal(appendUserTurn(conv, 'hello', { waMessageId: 'wamid.dup' }), true);
    assert.equal(appendUserTurn(conv, 'hello', { waMessageId: 'wamid.dup' }), false);
    assert.equal(conv.history.length, 1);

    assert.equal(appendAssistantTurn(conv, 'reply', { refWaMessageId: 'wamid.dup' }), true);
    assert.equal(appendAssistantTurn(conv, 'reply', { refWaMessageId: 'wamid.dup' }), false);
    assert.equal(conv.history.length, 2);
  });
});

describe('mergeSlots (MEMORY.md §3.5 never overwrite filled fields with null)', () => {
  it('only merges non-null values, preserving earlier answers', () => {
    const merged = mergeSlots(
      { name: 'Ahmed', date: '2026-08-02' },
      { name: null, date: undefined, time: '17:00', reason: 'fever' },
    );
    assert.deepEqual(merged, { name: 'Ahmed', date: '2026-08-02', time: '17:00', reason: 'fever' });
  });

  it('overwrites a field with a genuine new value', () => {
    assert.deepEqual(mergeSlots({ name: 'Ahmed' }, { name: 'Ahmed Raza' }), { name: 'Ahmed Raza' });
  });

  it('skips empty-string values', () => {
    assert.deepEqual(mergeSlots({ name: 'Ahmed' }, { name: '', phone: '+923001234567' }), {
      name: 'Ahmed',
      phone: '+923001234567',
    });
  });
});

describe('persistConversation (MEMORY.md §3.6 write-through Mongo + Redis)', () => {
  it('upserts to Mongo AND refreshes the Redis cache', async () => {
    const conv = await readConversation(PHONE);
    conv.state = 'COLLECTING_DATETIME';
    conv.slots = mergeSlots(conv.slots, { name: 'Ahmed Raza', reason: 'fever' });
    appendUserTurn(conv, 'fever hai', { waMessageId: 'wamid.persist.1' });

    const doc = await persistConversation(conv);

    const fromMongo = await Conversation.findOne({ phone: PHONE }).lean();
    assert.equal(fromMongo.state, 'COLLECTING_DATETIME');
    assert.equal(fromMongo.slots.name, 'Ahmed Raza');
    assert.equal(fromMongo.slots.phone, PHONE);
    assert.equal(doc.slots.name, 'Ahmed Raza');

    const cached = JSON.parse(await redis.get(convKey(PHONE)));
    assert.equal(cached.state, 'COLLECTING_DATETIME');
    assert.equal(cached.slots.reason, 'fever');
    assert.equal(cached.history.at(-1).meta.waMessageId, 'wamid.persist.1');
    assert.equal(conv._id, doc._id, 'caller object stays in sync with the persisted _id');
  });
});
