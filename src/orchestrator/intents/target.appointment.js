





export function matchTargetByHint(upcoming, input = {}) {
  if (input.targetAppointmentId) {
    return upcoming.find((a) => String(a._id) === String(input.targetAppointmentId)) || null;
  }
  if (input.targetDate && input.targetTime) {
    return upcoming.find((a) => a.date === input.targetDate && a.time === input.targetTime) || null;
  }
  return null;
}

export function resolveTargetAppointment(conv, upcoming, input = {}) {
  if (conv.slots?.targetAppointmentId) {
    const chosen = upcoming.find((a) => String(a._id) === String(conv.slots.targetAppointmentId));
    if (chosen) return chosen;
  }
  return matchTargetByHint(upcoming, input);
}
