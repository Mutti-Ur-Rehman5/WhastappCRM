import dayjs from 'dayjs';
import { DoctorConfig } from '../models/DoctorConfig.model.js';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';






export const DOCTOR_CONFIG_CACHE_TTL_SECONDS = 5 * 60;

export function doctorConfigKey(doctorId) {
  return `doctor:config:${doctorId}`;
}


export const DEFAULT_DOCTOR_CONFIG_KEY = 'doctor:config:default';

export function getRuleForDate(config, date) {
  const day = dayjs(date).format('dddd').toLowerCase();
  return config.workingHours.find((w) => w.day === day && w.enabled) || null;
}

export function isSlotValid(config, date, time) {
  if (!config) return { ok: false, reason: 'no_config' };
  if (config.holidays?.includes(date)) return { ok: false, reason: 'holiday' };
  const rule = getRuleForDate(config, date);
  if (!rule) return { ok: false, reason: 'closed_day' };
  if (time < rule.start || time >= rule.end) return { ok: false, reason: 'outside_hours' };

  const slotMinutes = rule.slotMinutes || 15;
  const timeMin = timeToMinutes(time);
  const slotEnd = timeMin + slotMinutes;
  if (rule.breaks?.some((b) => {
    const bStart = timeToMinutes(b.start);
    const bEnd = timeToMinutes(b.end);
    return timeMin < bEnd && slotEnd > bStart;
  })) return { ok: false, reason: 'break_time' };
  return { ok: true };
}

export function generateDaySlots(rule, bufferMinutes = 0) {
  const [startH, startM] = rule.start.split(':').map(Number);
  const [endH, endM] = rule.end.split(':').map(Number);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  const step = (rule.slotMinutes || 15) + (bufferMinutes || 0);
  const breaks = (rule.breaks || []).map((b) => {
    const [bH, bM] = b.start.split(':').map(Number);
    const [eH, eM] = b.end.split(':').map(Number);
    return { start: bH * 60 + bM, end: eH * 60 + eM };
  });

  const slots = [];
  for (let t = startMin; t + step <= endMin; t += step) {


    const slotEnd = t + (rule.slotMinutes || 15);
    if (breaks.some((b) => t < b.end && slotEnd > b.start)) continue;
    slots.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return slots;
}


export function timeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}


export function slotDurationForDate(config, date) {
  const rule = getRuleForDate(config, date);
  return (rule && rule.slotMinutes) || 15;
}

export function bufferMinutesFor(config) {
  return config?.bufferMinutes || 0;
}

export function maxPerSlotFor(config) {
  return config?.maxPerSlot || 1;
}

const DEFAULT_MAX_TOKENS_PER_DAY = 20;

export function maxTokensPerDayFor(config) {
  return config?.maxTokensPerDay || DEFAULT_MAX_TOKENS_PER_DAY;
}

export function isBufferClash(existingTime, newTime, slotMinutes, bufferMinutes) {
  const T = timeToMinutes(existingTime);
  const U = timeToMinutes(newTime);
  if (T === U) return false;
  const d = slotMinutes || 15;
  const b = bufferMinutes || 0;
  return U < T + d + b && T < U + d + b;
}

export async function getDoctorConfig({ doctorId, redisClient = redis } = {}) {
  const cacheKey = doctorId ? doctorConfigKey(doctorId) : DEFAULT_DOCTOR_CONFIG_KEY;

  const cached = await redisClient.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      logger.warn('Corrupt DoctorConfig cache entry, rebuilding from DB', { cacheKey });
    }
  }

  const config = doctorId
    ? await DoctorConfig.findById(doctorId).lean()
    : await DoctorConfig.findOne().sort({ createdAt: 1 }).lean();
  if (config) {
    await redisClient.set(cacheKey, JSON.stringify(config), 'EX', DOCTOR_CONFIG_CACHE_TTL_SECONDS);
  }
  return config;
}

export async function invalidateDoctorConfigCache({ doctorId, redisClient = redis } = {}) {
  const keys = [DEFAULT_DOCTOR_CONFIG_KEY];
  if (doctorId) keys.push(doctorConfigKey(doctorId));
  await redisClient.del(keys);
}
