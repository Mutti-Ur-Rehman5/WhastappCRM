import dayjs from 'dayjs';
import { Appointment } from '../models/Appointment.model.js';
import {
  generateDaySlots,
  getDoctorConfig,
  getRuleForDate,
  isBufferClash,
  slotDurationForDate,
  bufferMinutesFor,
  maxPerSlotFor,
  maxTokensPerDayFor,
} from './slot.service.js';
import { pendingRescheduleHeld } from './pendingReschedule.marker.js';
import { isSlotHeld } from './slotHold.service.js';









const MAX_DAYS_AHEAD = 14;

export async function findNearestAvailable(doctorId, date, time, count = 3, { config, redisClient, excludePhone } = {}) {
  const cfg = config || (await getDoctorConfig({ doctorId, redisClient }));
  if (!cfg) return [];

  const candidates = [];
  for (let d = 0; d < MAX_DAYS_AHEAD && candidates.length < count; d += 1) {
    const dayDate = dayjs(date).add(d, 'day').format('YYYY-MM-DD');
    if (cfg.holidays?.includes(dayDate)) continue;
    const rule = getRuleForDate(cfg, dayDate);
    if (!rule) continue;

    const booked = await Appointment.find({
      doctorId,
      date: dayDate,
      status: { $in: ['pending', 'confirmed'] },
    })
      .select({ time: 1 })
      .lean();
    const slotMin = slotDurationForDate(cfg, dayDate);
    const buffer = bufferMinutesFor(cfg);
    const capacity = maxPerSlotFor(cfg);



    const maxTokens = maxTokensPerDayFor(cfg);
    if (booked.length >= maxTokens) continue;

    for (const slot of generateDaySlots(rule, buffer)) {

      const sameTimeCount = booked.filter((b) => b.time === slot).length;
      if (sameTimeCount >= capacity) continue;


      if (booked.some((b) => b.time !== slot && isBufferClash(b.time, slot, slotMin, buffer))) continue;


      if (await pendingRescheduleHeld({ doctorId, date: dayDate, time: slot, redisClient })) continue;


      if (await isSlotHeld({ doctorId, date: dayDate, time: slot, excludePhone, redisClient })) continue;


      if (d === 0 && slot <= time) continue;
      candidates.push({ date: dayDate, time: slot });
      if (candidates.length >= count) break;
    }
  }
  return candidates;
}
