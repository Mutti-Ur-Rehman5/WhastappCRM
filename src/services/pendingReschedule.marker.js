import { redis } from '../config/redis.js';












export const PENDING_RESCHEDULE_PREFIX = 'pending:rs:';

export function pendingRescheduleKey(doctorId, date, time) {
  return `${PENDING_RESCHEDULE_PREFIX}${doctorId}:${date}:${time}`;
}

export async function pendingRescheduleHeld({ doctorId, date, time, excludeAppointmentId, redisClient = redis } = {}) {
  const value = await redisClient.get(pendingRescheduleKey(doctorId, date, time));
  if (!value) return null;
  if (excludeAppointmentId && String(value) === String(excludeAppointmentId)) return null;
  return value;
}
