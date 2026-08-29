














import { localized, doctorWith } from '../services/localization.service.js';

export const NOTIFY_EVENT_LABELS = {
  booked: 'New booking',
  cancelled: 'Cancelled',
  rescheduled: 'Rescheduled',
};

const EVENT_PREFIX = {
  booked: '🆕',
  cancelled: '❌',
  rescheduled: '🔄',
};


export function patientConfirmation({ tokenNo, date, time, doctorName, reason }, lang) {
  return (
    localized('confirm.done', lang, {
      tokenNo,
      date,
      time,
      withDoctor: doctorWith(doctorName, lang),
      reason,
    }) ??
    [
      `✅ Appointment confirmed. Token #${tokenNo}.`,
      `${date} at ${time} with ${doctorName || 'the doctor'}.`,
      `Reason: ${reason || '-'}`,
    ].join('\n')
  );
}


export function patientReminder({ tokenNo, date, time }, lang) {
  return (
    localized('reminder', lang, { tokenNo, date, time }) ??
    `⏰ Reminder: your appointment (Token #${tokenNo}) is on ${date} at ${time}.`
  );
}

export function doctorNotification({ event, tokenNo, patientName, patientPhone, date, time, reason }) {
  const label = NOTIFY_EVENT_LABELS[event] || NOTIFY_EVENT_LABELS.booked;
  const prefix = EVENT_PREFIX[event] || EVENT_PREFIX.booked;
  return [
    `${prefix} ${label}: Token #${tokenNo}, ${patientName} (${patientPhone}), ${date} ${time}.`,
    `Reason: ${reason || '-'}`,
  ].join('\n');
}

export function adminCancelledAppointment({ tokenNo, date, time, doctorName }, lang) {
  return (
    localized('admin.cancelled', lang, {
      tokenNo,
      date,
      time,
      withDoctor: doctorWith(doctorName, lang),
    }) ??
    [
      `❌ Your appointment (Token #${tokenNo}) for ${date} at ${time}${doctorName ? ` with ${doctorName}` : ''} was cancelled by the clinic.`,
      'Please send us a message or call to rebook.',
    ].join('\n')
  );
}

export function adminRescheduledAppointment({ tokenNo, date, time, newDate, newTime, doctorName }, lang) {
  return (
    localized('admin.rescheduled', lang, {
      tokenNo,
      date,
      time,
      newDate,
      newTime,
      withDoctor: doctorWith(doctorName, lang),
    }) ??
    [
      `🔄 Your appointment (Token #${tokenNo}) was rescheduled by the clinic.`,
      `Old: ${date} at ${time}.`,
      `New: ${newDate} at ${newTime}${doctorName ? ` with ${doctorName}` : ''}.`,
      'Reply CANCEL or RESCHEDULE if this does not work for you.',
    ].join('\n')
  );
}

export function rescheduleProposal({ date, time, newDate, newTime }, lang) {
  return (
    localized('reschedule.proposal', lang, { date, time, newDate, newTime }) ??
    `Your appointment on ${date} at ${time} needs to be rescheduled.\n\nNew time: ${newDate} at ${newTime}.\n\nDo you accept?`
  );
}


export function rescheduleConfirmedPatient({ tokenNo, newDate, newTime }, lang) {
  return (
    localized('reschedule.confirmed', lang, { tokenNo, newDate, newTime }) ??
    [
      `✅ Done! Your appointment (Token #${tokenNo}) is now ${newDate} at ${newTime}.`,
      'See you there!',
    ].join('\n')
  );
}


export function rescheduleDeclinedPatient({ tokenNo, date, time }, lang) {
  return (
    localized('reschedule.declined', lang, { tokenNo, date, time }) ??
    [
      `No problem — your appointment (Token #${tokenNo}) stays on ${date} at ${time}.`,
      'The clinic will contact you separately if they need to find another time.',
    ].join('\n')
  );
}


export function rescheduleExpiredPatient({ tokenNo, date }, lang) {
  return (
    localized('reschedule.expired', lang, { tokenNo, date }) ??
    [
      `Your appointment (Token #${tokenNo}) was NOT moved.`,
      `The proposed ${date} reschedule expired before you could answer, so nothing changed — your appointment stays on your original time.`,
      'The clinic will contact you if a new time is still needed.',
    ].join('\n')
  );
}


export function rescheduleDoctorResult({ result, patientName, patientPhone, tokenNo, newDate, newTime }) {
  const label =
    result === 'accepted'
      ? 'ACCEPTED the proposed reschedule'
      : result === 'declined'
        ? 'DECLINED the proposed reschedule'
        : 'did not respond to the proposed reschedule before it expired';
  return `${patientName} (${patientPhone}) ${label} for Token #${tokenNo}.\nProposed: ${newDate} ${newTime}.`;
}


export function rescheduleAlreadyHandled(lang) {
  return localized('reschedule.alreadyHandled', lang) ?? 'This reschedule request has already been handled. Please message the clinic if you need anything else.';
}


export function rescheduleSlotNoLongerAvailable(lang) {
  return localized('reschedule.slotLost', lang) ?? 'Sorry, that reschedule time is no longer available. Your appointment stays at your original time — please message the clinic to arrange a new time.';
}
