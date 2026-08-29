import { mergeSlots } from '../../services/conversation.memory.service.js';
import {
  findUpcomingAppointments,
  rescheduleAppointment,
} from '../../services/booking.service.js';
import { findNearestAvailable } from '../../services/suggestion.service.js';
import { getDoctorConfig } from '../../services/slot.service.js';
import { localized, doctorWith, confirmButtons, postBookButtons } from '../../services/localization.service.js';
import {
  SlotTakenError,
  AppointmentNotFoundError,
  AppointmentNotActiveError,
} from '../../utils/errors.js';
import { buildSlotTakenReply } from './book.intent.js';
import { resolveTargetAppointment } from './target.appointment.js';









const NEW_DATETIME_QUESTION =
  'Kis naye din aur kis waqt par aana chahate hain? / Which new day and what time would you like?';
const DECLINED_REPLY = 'Okay, no problem. Let me know if you would like to try again.';
const NOTHING_REPLY = 'Aapke paas reschedule karne ke liye koi upcoming appointment nahi hai. / You have no upcoming confirmed appointments to reschedule.';
const NOT_ACTIVE_REPLY = 'Wo appointment ab active nahi hai. / That appointment is no longer active.';
const NO_TARGET_REPLY =
  'Pehle bata dein konsi appointment reschedule karni hai. / Please tell me which appointment to reschedule first.';

function formatAppointmentLine(a, index) {
  const prefix = index === undefined ? '' : `${index + 1}. `;
  return `${prefix}${a.date} at ${a.time} (Token #${a.tokenNo})`;
}

function disambiguateReply(upcoming, lang) {
  const countLine =
    localized('reschedule.youHave', lang, { count: upcoming.length }) ??
    `Aapke paas ${upcoming.length} upcoming appointments hain. / You have ${upcoming.length} upcoming appointments.`;
  const whichLine = localized('reschedule.which', lang) ?? 'Konsi reschedule karni hai? / Which one would you like to reschedule?';
  return [countLine, whichLine, ...upcoming.map((a, i) => formatAppointmentLine(a, i))].join('\n');
}

export function rescheduleSummary(target, slots, lang) {
  const current = `${target.date} at ${target.time} (Token #${target.tokenNo})`;
  const next = `${slots.date} at ${slots.time}`;
  return (
    localized('reschedule.summary', lang, { current, new: next }) ??
    ['Reschedule karein? / Please confirm:', `Current: ${current}`, `New: ${next}`].join('\n')
  );
}

export async function handleRescheduleIntent({ conv, input = {} }) {
  const upcoming = await findUpcomingAppointments({ patientPhone: conv.phone });
  const slots = mergeSlots(conv.slots, { date: input.newDate, time: input.newTime });
  let target = resolveTargetAppointment(conv, upcoming, input);

  if (!target) {
    if (upcoming.length === 0) {
      return { slots, nextState: 'IDLE', reply: localized('reschedule.nothing', conv.language) ?? NOTHING_REPLY, clearSlots: true, clearIntent: true };
    }
    if (upcoming.length === 1) {

      target = upcoming[0];
      slots.targetAppointmentId = target._id;
    } else {

      return { slots, nextState: 'IDENTIFY_TARGET_APPOINTMENT', reply: disambiguateReply(upcoming, conv.language) };
    }
  } else {
    slots.targetAppointmentId = target._id;
  }

  if (!slots.date || !slots.time) {
    return { slots, nextState: 'COLLECTING_NEW_DATETIME', reply: localized('reschedule.ask.datetime', conv.language) ?? NEW_DATETIME_QUESTION };
  }
  return { slots, nextState: 'AWAITING_CONFIRMATION', reply: rescheduleSummary(target, slots, conv.language), buttons: confirmButtons(conv.language) };
}

export async function handleRescheduleConfirm({
  conv,
  value,
  doctorConfig,
  enqueueSheetSync,
  enqueueNotifyDoctor,
  enqueueScheduleReminders,
  removeReminderJobs,
  correlationId,
}) {
  if (value !== true) {
    return { reply: localized('book.declined', conv.language) ?? DECLINED_REPLY, nextState: 'IDLE', clearSlots: true, clearIntent: true };
  }

  const { targetAppointmentId, date, time } = conv.slots || {};
  if (!targetAppointmentId || !date || !time) {
    return { reply: localized('reschedule.noTarget', conv.language) ?? NO_TARGET_REPLY, nextState: 'IDENTIFY_TARGET_APPOINTMENT' };
  }

  const config = doctorConfig || (await getDoctorConfig());
  if (!config) throw new Error('DoctorConfig missing — cannot reschedule');

  try {
    const { appointment } = await rescheduleAppointment(
      {
        appointmentId: targetAppointmentId,
        newDate: date,
        newTime: time,
      },
      { enqueueSheetSync, enqueueNotifyDoctor, enqueueScheduleReminders, removeReminderJobs, correlationId },
    );
    return {
      reply:
        localized('reschedule.done', conv.language, {
          tokenNo: appointment.tokenNo,
          date: appointment.date,
          time: appointment.time,
          withDoctor: doctorWith(config.doctorName, conv.language),
        }) ??
        [
          `Appointment rescheduled. New Token #${appointment.tokenNo}.`,
          `${appointment.date} at ${appointment.time} with ${config.doctorName}.`,
        ].join('\n'),
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
    if (err instanceof AppointmentNotFoundError || err instanceof AppointmentNotActiveError) {
      return { reply: localized('reschedule.notActive', conv.language) ?? NOT_ACTIVE_REPLY, nextState: 'IDLE', clearSlots: true, clearIntent: true, error: err };
    }
    throw err;
  }
}
