import { Appointment } from '../../models/Appointment.model.js';
import {
  generateDaySlots,
  getDoctorConfig,
  getRuleForDate,
  isBufferClash,
  slotDurationForDate,
  bufferMinutesFor,
  maxPerSlotFor,
} from '../../services/slot.service.js';
import { findUpcomingAppointments, ACTIVE_STATUSES } from '../../services/booking.service.js';
import { clinicNow } from '../../utils/datetime.util.js';
import { localized } from '../../services/localization.service.js';









const NO_CONFIG_REPLY = 'Clinic ka schedule abhi set nahi hua. / No clinic schedule is configured yet.';
const NO_APPOINTMENTS_REPLY =
  'Aapke paas koi upcoming appointment nahi hai. / You have no upcoming appointments.';

const MAX_SLOTS_SHOWN = 12;

function formatHours(rule) {
  const base = `${rule.start} – ${rule.end}`;
  const breaks = rule.breaks?.length
    ? ` (break ${rule.breaks.map((b) => `${b.start}–${b.end}`).join(', ')})`
    : '';
  return base + breaks;
}


export function buildScheduleReply(config, lang) {
  const lines = config.workingHours.map((w) => {
    const day = w.day[0].toUpperCase() + w.day.slice(1);
    return w.enabled ? `${day}: ${formatHours(w)}` : `${day}: Closed / Band`;
  });
  if (config.holidays?.length) {
    lines.push(`Holidays (band): ${config.holidays.join(', ')}`);
  }
  return [
    localized('query.hours', lang) ?? `${config.doctorName} ka schedule / Clinic hours:`,
    ...lines,
    localized('query.bookHint', lang) ?? 'Book karne ke liye date aur time batayen. / Tell us a date and time to book.',
  ].join('\n');
}

async function freeSlotsOnDate(config, date) {
  const booked = await Appointment.find({
    doctorId: config._id,
    date,
    status: { $in: ACTIVE_STATUSES },
  })
    .select({ time: 1 })
    .lean();

  const rule = getRuleForDate(config, date);
  const slotMin = slotDurationForDate(config, date);
  const buffer = bufferMinutesFor(config);
  const capacity = maxPerSlotFor(config);

  const now = clinicNow();
  const isToday = date === now.format('YYYY-MM-DD');
  const nowTime = now.format('HH:mm');

  return generateDaySlots(rule, buffer).filter((slot) => {
    if (booked.filter((b) => b.time === slot).length >= capacity) return false;
    if (booked.some((b) => b.time !== slot && isBufferClash(b.time, slot, slotMin, buffer))) return false;
    if (isToday && slot <= nowTime) return false;
    return true;
  });
}

export async function handleAvailabilityIntent({ conv, input = {}, config } = {}) {
  const cfg = config || (await getDoctorConfig());
  if (!cfg) return { reply: localized('query.noConfig', conv.language) ?? NO_CONFIG_REPLY, nextState: conv.state };

  const { date } = input;
  if (!date) return { reply: buildScheduleReply(cfg, conv.language), nextState: conv.state };

  if (cfg.holidays?.includes(date)) {
    return { reply: localized('query.holiday', conv.language, { date }) ?? `Doctor is closed on ${date} (holiday). / Doctor ${date} ko band hain.`, nextState: conv.state };
  }
  const rule = getRuleForDate(cfg, date);
  if (!rule) {
    return { reply: localized('query.closedDay', conv.language, { date }) ?? `The clinic is closed on ${date}. / Clinic ${date} ko band hai.`, nextState: conv.state };
  }
  const today = clinicNow().format('YYYY-MM-DD');
  if (date < today) {
    return { reply: localized('query.past', conv.language) ?? `${date} guzar chuka hai. / That day is in the past.`, nextState: conv.state };
  }

  const free = await freeSlotsOnDate(cfg, date);
  const shown = free.slice(0, MAX_SLOTS_SHOWN);
  const more = free.length - shown.length;
  const slotsLine = shown.length ? shown.join(', ') : '';
  const tail =
    more > 0
      ? `\n${localized('query.more', conv.language, { count: more }) ?? `+${more} aur times bhi hain. / and ${more} more times.`}`
      : '';
  const headline =
    free.length === 0
      ? localized('query.noSlots', conv.language, { date }) ?? `Us din koi free slot nahi bacha. / No free slots left on ${date}.`
      : localized('query.available', conv.language, { date }) ?? `Doctor is available on ${date} at: / Doctor ${date} ko in waqton par available hain:`;

  return {
    reply: [
      headline,
      slotsLine,
      tail,
      localized('query.whichTime', conv.language) ?? 'Bata dein kaunsa time theek hai. / Tell me which time works.',
    ].filter(Boolean).join('\n'),
    nextState: conv.state,
  };
}

export async function handleQueryAppointmentsIntent({ conv }) {
  const upcoming = await findUpcomingAppointments({ patientPhone: conv.phone });
  if (upcoming.length === 0) return { reply: localized('query.noAppointments', conv.language) ?? NO_APPOINTMENTS_REPLY, nextState: conv.state };

  const lines = upcoming.map((a) => `- ${a.date} at ${a.time} (Token #${a.tokenNo})`);
  return {
    reply: [
      localized('query.upcoming', conv.language, { count: upcoming.length }) ?? `Aapke upcoming appointments / Your upcoming appointments (${upcoming.length}):`,
      ...lines,
      localized('query.anythingElse', conv.language) ?? 'Kuch aur chahiye? / Anything else?',
    ].join('\n'),
    nextState: conv.state,
  };
}
