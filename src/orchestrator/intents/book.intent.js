import { Patient } from '../../models/Patient.model.js';
import { mergeSlots } from '../../services/conversation.memory.service.js';
import { bookAppointment } from '../../services/booking.service.js';
import { findNearestAvailable } from '../../services/suggestion.service.js';
import { getDoctorConfig } from '../../services/slot.service.js';
import { SlotTakenError } from '../../utils/errors.js';
import { patientConfirmation } from '../../prompts/templates.js';
import { localized, doctorWith, confirmButtons, postBookButtons } from '../../services/localization.service.js';
import { BOOK_FIELD_STATES, missingBookingFields } from '../stateMachine.js';
import { clinicNow, todayInClinicTimeZone } from '../../utils/datetime.util.js';






const BILINGUAL_FOLLOW_UP = {
  name: "Sure! Aapka naam kya hai? / What's your name?",
  phone: 'Aapka phone number kya hai? / What is your phone number?',
  reason: 'Visit kis wajah se karni hai? / What is the reason for your visit?',
};

const FOLLOW_UP_IDS = { name: 'ask.name', phone: 'ask.phone', reason: 'ask.reason' };

function followUpQuestion(field, lang) {
  return localized(FOLLOW_UP_IDS[field], lang) ?? BILINGUAL_FOLLOW_UP[field];
}

export function confirmSummary(slots, lang) {
  return (
    localized('book.confirm', lang, {
      date: slots.date,
      time: slots.time,
      name: slots.name,
      reason: slots.reason,
    }) ??
    [
      'Confirm karein? / Please confirm:',
      `Date: ${slots.date}  Time: ${slots.time}`,
      `Name: ${slots.name}`,
      `Reason: ${slots.reason}`,
    ].join('\n')
  );
}

const RESTART_REPLY =
  'Koi baat nahi — let us start over. Which day and what time works for you?';
export const DECLINED_REPLY = 'Okay, no problem. Let us know whenever you would like to book an appointment.';
export const NO_SLOT_REPLY =
  'Sorry, I could not find any available slot in the next 14 days. Please try again later or contact the clinic.';

export function handleBookIntent({ conv, input = {} }) {
  const slots = mergeSlots(conv.slots, {
    date: input.date,
    time: input.time,
    name: input.name,
    reason: input.reason,
    phone: input.phone,
  });

  const missing = missingBookingFields(slots);
  if (missing.length > 0) {
    return {
      slots,
      nextState: BOOK_FIELD_STATES[missing[0]],
      reply: followUpQuestion(missing[0], conv.language),
      missing,
    };
  }

  return {
    slots,
    nextState: 'AWAITING_CONFIRMATION',
    missing: [],
    reply: confirmSummary(slots, conv.language),
    buttons: confirmButtons(conv.language),
  };
}

export async function findAutoSlot(doctorId, { config, todayRef } = {}) {
  const cfg = config || (await getDoctorConfig({ doctorId }));
  if (!cfg) return null;
  const today = todayRef || todayInClinicTimeZone();
  const now = clinicNow();
  const currentTime = now.format('HH:mm');
  const alternatives = await findNearestAvailable(doctorId, today, currentTime, 1, { config: cfg });
  return alternatives.length > 0 ? alternatives[0] : null;
}

export async function ensurePatient({ phone, name }) {
  const existing = await Patient.findOne({ phone });
  if (existing) {
    if (name && name !== existing.name) {
      existing.name = name;
      await existing.save();
    }
    return existing;
  }
  return Patient.create({ phone, name: name || phone });
}

export function bookingConfirmedReply(appointment, config, lang) {
  const localizedText = localized('confirm.done', lang, {
    tokenNo: appointment.tokenNo,
    date: appointment.date,
    time: appointment.time,
    withDoctor: doctorWith(config?.doctorName, lang),
    reason: appointment.reason,
  });
  if (localizedText) return localizedText;
  return patientConfirmation({
    tokenNo: appointment.tokenNo,
    date: appointment.date,
    time: appointment.time,
    doctorName: config?.doctorName,
    reason: appointment.reason,
  });
}

export async function handleConfirmIntent({
  conv,
  value,
  doctorConfig,
  enqueueSheetSync,
  enqueueNotifyDoctor,
  enqueueNotifyPatientConfirmation,
  enqueueScheduleReminders,
  correlationId,
}) {
  if (value !== true) {
    return { reply: DECLINED_REPLY, nextState: 'IDLE', clearSlots: true, clearIntent: true };
  }

  const { date, time, name, reason } = conv.slots || {};
  if (!date || !time) {

    return { reply: RESTART_REPLY, nextState: 'IDLE', clearSlots: true, clearIntent: true };
  }

  const config = doctorConfig || (await getDoctorConfig());
  if (!config) throw new Error('DoctorConfig missing — cannot book');

  const patient = await ensurePatient({ phone: conv.phone, name });

  try {
    const appointment = await bookAppointment(
      {
        doctorId: config._id,
        date,
        time,
        patient,
        reason,
      },
      { enqueueSheetSync, enqueueNotifyDoctor, enqueueNotifyPatientConfirmation, enqueueScheduleReminders, correlationId },
    );
    return {
      reply: bookingConfirmedReply(appointment, config, conv.language),
      nextState: 'IDLE',
      clearSlots: true,
      clearIntent: true,
      appointment,
      buttons: postBookButtons(conv.language),
    };
  } catch (err) {

    if (err instanceof SlotTakenError) {
      const alternatives = await findNearestAvailable(config._id, err.date, err.time, 3, { config });
      return {
        reply: buildSlotTakenReply(err, alternatives, conv.language),
        nextState: 'AWAITING_CONFIRMATION',
        clearSlots: false,
        clearIntent: false,
        error: err,
      };
    }
    throw err;
  }
}


export function buildSlotTakenReply(err, alternatives, lang) {
  return buildUnavailableReply(err.date, err.time, err.reason, alternatives, lang);
}




const REASON_LINES = {
  holiday: (date, lang) => localized('query.holiday', lang, { date }) ?? `The clinic is closed on ${date} (holiday).`,
  closed_day: (date, lang) => localized('query.closedDay', lang, { date }) ?? `The clinic is closed on ${date}.`,
  outside_hours: (date, time, lang) => localized('slot.outsideHours', lang, { date, time }) ?? `${date} at ${time} is outside the clinic's working hours.`,
  break_time: (date, time, lang) => localized('slot.breakTime', lang, { date, time }) ?? 'The clinic is on a break at that time.',
  in_the_past: (date, time, lang) => localized('slot.inPast', lang, { date, time }) ?? 'That time has already passed.',
  day_full: (date, lang) => localized('slot.dayFull', lang, { date }) ?? `Sorry, all appointment slots for ${date} are full. The doctor is not available for further bookings that day. Please try another day.`,
  no_config: () => 'No clinic schedule is configured yet — please contact the clinic.',
};

export function buildUnavailableReply(date, time, reason, alternatives = [], lang) {
  const headline = REASON_LINES[reason]?.(date, time, lang) || localized('slot.taken', lang, { date, time }) || `Sorry, ${date} at ${time} is already taken.`;
  const lines = alternatives.map((a, i) => `${i + 1}. ${a.date} at ${a.time}`);

  if (alternatives.length === 0) {
    return [
      headline,
      localized('slot.none', lang) ?? 'I could not find any other free slot in the next 14 days.\nPlease try another day and time, or contact the clinic.',
    ].join('\n');
  }
  return [
    headline,
    localized('slot.alternatives', lang) ?? 'Nearest available options:',
    ...lines,
    localized('slot.choose', lang) ?? 'Reply with a number, or tell me another day and time.',
  ].join('\n');
}
