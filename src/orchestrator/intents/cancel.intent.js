import {
  findUpcomingAppointments,
  cancelAppointment,
} from '../../services/booking.service.js';
import { localized } from '../../services/localization.service.js';
import {
  AppointmentNotFoundError,
  AppointmentNotActiveError,
} from '../../utils/errors.js';
import { resolveTargetAppointment } from './target.appointment.js';









const DECLINED_REPLY = 'Okay, no problem. Your appointment stays as it is.';
const NOTHING_REPLY = 'Aapke paas cancel karne ke liye koi upcoming appointment nahi hai. / You have no upcoming confirmed appointments to cancel.';
const NOT_ACTIVE_REPLY = 'Wo appointment ab active nahi hai. / That appointment is no longer active.';
const NO_TARGET_REPLY =
  'Pehle bata dein konsi appointment cancel karni hai. / Please tell me which appointment to cancel first.';

function formatAppointmentLine(a, index) {
  const prefix = index === undefined ? '' : `${index + 1}. `;
  return `${prefix}${a.date} at ${a.time} (Token #${a.tokenNo})`;
}

function disambiguateReply(upcoming, lang) {
  const countLine =
    localized('cancel.youHave', lang, { count: upcoming.length }) ??
    `Aapke paas ${upcoming.length} upcoming appointments hain. / You have ${upcoming.length} upcoming appointments.`;
  const whichLine = localized('cancel.which', lang) ?? 'Konsi cancel karni hai? / Which one would you like to cancel?';
  return [countLine, whichLine, ...upcoming.map((a, i) => formatAppointmentLine(a, i))].join('\n');
}

function cancelSummary(target, lang) {
  const line = `${target.date} at ${target.time} (Token #${target.tokenNo})`;
  return localized('cancel.summary', lang, { line }) ??
    ['Cancel karein? / Please confirm:', line, 'Reply YES to cancel, or NO to keep it.'].join('\n');
}

export async function handleCancelIntent({ conv, input = {} }) {
  const upcoming = await findUpcomingAppointments({ patientPhone: conv.phone });
  const target = resolveTargetAppointment(conv, upcoming, input);

  if (!target) {
    if (upcoming.length === 0) {
      return { slots: conv.slots, nextState: 'IDLE', reply: localized('cancel.nothing', conv.language) ?? NOTHING_REPLY, clearSlots: true, clearIntent: true };
    }
    if (upcoming.length === 1) {

      conv.slots.targetAppointmentId = upcoming[0]._id;
      return { slots: conv.slots, nextState: 'AWAITING_CONFIRMATION', reply: cancelSummary(upcoming[0], conv.language) };
    }

    return { slots: conv.slots, nextState: 'IDENTIFY_TARGET_APPOINTMENT', reply: disambiguateReply(upcoming, conv.language) };
  }

  conv.slots.targetAppointmentId = target._id;
  return { slots: conv.slots, nextState: 'AWAITING_CONFIRMATION', reply: cancelSummary(target, conv.language) };
}

export async function handleCancelConfirm({
  conv,
  value,
  enqueueSheetSync,
  enqueueNotifyDoctor,
  removeReminderJobs,
  correlationId,
}) {
  if (value !== true) {
    return { reply: localized('cancel.declined', conv.language) ?? DECLINED_REPLY, nextState: 'IDLE', clearSlots: true, clearIntent: true };
  }

  const { targetAppointmentId } = conv.slots || {};
  if (!targetAppointmentId) {
    return { reply: localized('cancel.noTarget', conv.language) ?? NO_TARGET_REPLY, nextState: 'IDENTIFY_TARGET_APPOINTMENT' };
  }

  try {
    const appointment = await cancelAppointment(
      { appointmentId: targetAppointmentId },
      { enqueueSheetSync, enqueueNotifyDoctor, removeReminderJobs, correlationId },
    );
    return {
      reply:
        localized('cancel.done', conv.language, {
          tokenNo: appointment.tokenNo,
          date: appointment.date,
          time: appointment.time,
        }) ?? `Appointment cancelled. Token #${appointment.tokenNo} (${appointment.date} at ${appointment.time}).`,
      nextState: 'IDLE',
      clearSlots: true,
      clearIntent: true,
      appointment,
    };
  } catch (err) {
    if (err instanceof AppointmentNotFoundError || err instanceof AppointmentNotActiveError) {
      return { reply: localized('cancel.notActive', conv.language) ?? NOT_ACTIVE_REPLY, nextState: 'IDLE', clearSlots: true, clearIntent: true, error: err };
    }
    throw err;
  }
}
