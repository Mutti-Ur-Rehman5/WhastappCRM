import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';







const SLOT_HOLD_PREFIX = 'hold:slot:';
export const SLOT_HOLD_TTL_SECONDS = 120;

export function slotHoldKey(doctorId, date, time) {
  return `${SLOT_HOLD_PREFIX}${doctorId}:${date}:${time}`;
}

export async function setSlotHold({ doctorId, date, time, phone, redisClient = redis }) {
  const key = slotHoldKey(doctorId, date, time);
  const existing = await redisClient.get(key);
  if (existing && existing !== phone) {
    logger.warn('Slot hold rejected — held by another patient', { doctorId, date, time, holder: existing, requester: phone });
    return false;
  }
  await redisClient.set(key, phone, 'EX', SLOT_HOLD_TTL_SECONDS);
  return true;
}

export async function releaseSlotHold({ doctorId, date, time, phone, redisClient = redis }) {
  const key = slotHoldKey(doctorId, date, time);
  if (phone) {
    const existing = await redisClient.get(key);
    if (existing && existing !== phone) return;
  }
  await redisClient.del(key);
}

export async function isSlotHeld({ doctorId, date, time, excludePhone, redisClient = redis }) {
  const key = slotHoldKey(doctorId, date, time);
  const holder = await redisClient.get(key);
  if (!holder) return false;
  if (excludePhone && holder === excludePhone) return false;
  return true;
}
