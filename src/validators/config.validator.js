import Joi from 'joi';
import { WEEKDAYS } from '../models/DoctorConfig.model.js';

// Joi schema for PUT /api/config (RULES.md §5). Validates the SHAPE
// thoroughly — invalid day names, malformed times, start>=end, breaks that
// overlap or fall outside the day window, duplicate days and bad holiday dates
// are all rejected with a 400 before anything touches the DB. The Mongoose
// schema validation then runs again on save() as defense in depth.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function timeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

const timeMessage = 'time must be a 24h HH:mm value';

const breakSchema = Joi.object({
  start: Joi.string().pattern(TIME_RE, timeMessage).required(),
  end: Joi.string().pattern(TIME_RE, timeMessage).required(),
}).custom((value, helpers) => {
  if (timeToMinutes(value.end) <= timeToMinutes(value.start)) {
    return helpers.message(`break end must be after break start (${value.start})`);
  }
  return value;
});

const workingHoursEntrySchema = Joi.object({
  day: Joi.string()
    .valid(...WEEKDAYS)
    .messages({ 'any.only': 'day must be one of: monday..sunday' })
    .required(),
  enabled: Joi.boolean().default(true),
  start: Joi.string().pattern(TIME_RE, timeMessage).required(),
  end: Joi.string().pattern(TIME_RE, timeMessage).required(),
  slotMinutes: Joi.number().integer().min(1).max(120).default(15),
  breaks: Joi.array().items(breakSchema).default([]),
}).custom((value, helpers) => {
  if (timeToMinutes(value.end) <= timeToMinutes(value.start)) {
    return helpers.message(`${value.day}: end must be after start (${value.start})`);
  }
  for (const breakItem of value.breaks) {
    if (timeToMinutes(breakItem.start) < timeToMinutes(value.start) || timeToMinutes(breakItem.end) > timeToMinutes(value.end)) {
      return helpers.message(
        `${value.day}: break (${breakItem.start}-${breakItem.end}) must lie inside working hours (${value.start}-${value.end})`,
      );
    }
  }
  return value;
});

export const configPutSchema = Joi.object({
  workingHours: Joi.array()
    .items(workingHoursEntrySchema)
    .min(1)
    .max(7)
    .custom((value, helpers) => {
      const days = value.map((entry) => entry.day);
      if (new Set(days).size !== days.length) {
        return helpers.message(`workingHours lists a day more than once: ${days.join(', ')}`);
      }
      for (const entry of value) {
        const sorted = [...entry.breaks].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
        for (let i = 1; i < sorted.length; i += 1) {
          if (timeToMinutes(sorted[i].start) < timeToMinutes(sorted[i - 1].end)) {
            return helpers.message(
              `${entry.day}: breaks must not overlap (${sorted[i - 1].start}-${sorted[i - 1].end} and ${sorted[i].start}-${sorted[i].end})`,
            );
          }
        }
      }
      return value;
    }),
  holidays: Joi.array()
    .items(Joi.string().pattern(DATE_RE, 'holiday must be formatted YYYY-MM-DD'))
    .unique()
    .default([]),
  bufferMinutes: Joi.number().integer().min(0).max(180),
  maxPerSlot: Joi.number().integer().min(1).max(20),
  maxTokensPerDay: Joi.number().integer().min(1).max(200),
  reminderOffsetsHours: Joi.array()
    .items(Joi.number().integer().min(0).max(168))
    .unique()
    .max(10),
})
  .unknown(false)
  .min(1);
