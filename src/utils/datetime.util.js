import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { env } from '../config/env.js';





dayjs.extend(utc);
dayjs.extend(timezone);

export function clinicNow(now = new Date()) {
  return dayjs(now).tz(env.clinicTimezone);
}


export function todayInClinicTimeZone(now = new Date()) {
  return clinicNow(now).format('YYYY-MM-DD');
}

export function toUtcInstant(date, time) {
  return dayjs.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', env.clinicTimezone).toDate();
}
