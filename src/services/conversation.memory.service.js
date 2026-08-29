import mongoose from 'mongoose';
import { Conversation } from '../models/Conversation.model.js';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';




export const CONV_CACHE_PREFIX = 'conv:';
export const CONV_CACHE_TTL_SECONDS = 30 * 60;
export const HISTORY_MAX_TURNS = 20;








export const CONV_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function convKey(phone) {
  return `${CONV_CACHE_PREFIX}${phone}`;
}

function freshConversation(phone, { language } = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    phone,
    state: 'IDLE',
    pendingIntent: null,
    slots: { phone },
    history: [],
    lastMessageAt: new Date(),


    language: language || null,
  };
}

export async function readConversation(phone, { redisClient = redis } = {}) {
  const cacheKey = convKey(phone);

  const cached = await redisClient.get(cacheKey);
  if (cached) {
    try {
      const conv = seedSenderPhone(JSON.parse(cached), phone);
      if (isStale(conv)) return freshConversation(phone, { language: conv.language });
      return conv;
    } catch {
      logger.warn('Corrupt conversation cache entry, rebuilding from Mongo', { phone });
    }
  }

  let conv = await Conversation.findOne({ phone }).lean();
  if (conv) {
    conv = seedSenderPhone(conv, phone);
    if (isStale(conv)) {
      logger.info('Conversation reset (idle timeout)', { phone });
      return freshConversation(phone, { language: conv.language });
    }
    await redisClient.set(cacheKey, JSON.stringify(conv), 'EX', CONV_CACHE_TTL_SECONDS);
    return conv;
  }

  const fresh = freshConversation(phone);
  await redisClient.set(cacheKey, JSON.stringify(fresh), 'EX', CONV_CACHE_TTL_SECONDS);
  return fresh;
}


function isStale(conv) {
  const last = conv?.lastMessageAt ? new Date(conv.lastMessageAt).getTime() : 0;
  if (!Number.isFinite(last) || last <= 0) return true;
  return Date.now() - last > CONV_IDLE_TIMEOUT_MS;
}


function seedSenderPhone(conv, phone) {
  if (!conv.slots) conv.slots = {};
  if (conv.slots.phone === undefined || conv.slots.phone === null || conv.slots.phone === '') {
    conv.slots.phone = phone;
  }
  return conv;
}

function trimHistory(history) {
  while (history.length > HISTORY_MAX_TURNS) history.shift();
}

export function appendUserTurn(conv, text, { waMessageId } = {}) {
  if (waMessageId && conv.history.some((h) => h.role === 'user' && h.meta?.waMessageId === waMessageId)) {
    return false;
  }
  conv.history.push({
    role: 'user',
    text,
    ts: new Date(),
    meta: waMessageId ? { waMessageId } : undefined,
  });
  trimHistory(conv.history);
  return true;
}


export function appendAssistantTurn(conv, text, { refWaMessageId } = {}) {
  if (refWaMessageId && conv.history.some((h) => h.role === 'assistant' && h.meta?.refWaMessageId === refWaMessageId)) {
    return false;
  }
  conv.history.push({
    role: 'assistant',
    text,
    ts: new Date(),
    meta: refWaMessageId ? { refWaMessageId } : undefined,
  });
  trimHistory(conv.history);
  return true;
}

export function mergeSlots(slots, incoming = {}) {
  const merged = { ...(slots || {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined && value !== '') merged[key] = value;
  }
  return merged;
}

export async function persistConversation(conv, { redisClient = redis } = {}) {
  const now = new Date();
  const doc = await Conversation.findOneAndUpdate(
    { phone: conv.phone },
    {
      $set: {
        state: conv.state,
        pendingIntent: conv.pendingIntent ?? null,
        slots: conv.slots || {},
        history: conv.history || [],
        language: conv.language ?? null,
        lastMessageAt: now,
      },
      $setOnInsert: { _id: conv._id },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();


  conv._id = doc._id;
  conv.lastMessageAt = doc.lastMessageAt;

  await redisClient.set(convKey(conv.phone), JSON.stringify(doc), 'EX', CONV_CACHE_TTL_SECONDS);
  return doc;
}
