import { CONVERSATION_STATES } from '../models/Conversation.model.js';





export const BOOK_FIELD_STATES = {
  name: 'COLLECTING_NAME',
  phone: 'COLLECTING_PHONE',
  reason: 'COLLECTING_REASON',
};













export const BOOK_FIELD_ORDER = ['name', 'reason'];


export function missingBookingFields(slots) {
  const missing = [];
  if (!slots?.name) missing.push('name');
  if (!slots?.reason) missing.push('reason');
  return missing;
}

export function nextStateForBook(slots) {
  const missing = missingBookingFields(slots);
  return missing.length === 0 ? 'AWAITING_CONFIRMATION' : BOOK_FIELD_STATES[missing[0]];
}

export function computeNextState(conv, { intent, slots, confirm }) {
  const from = conv.state;

  if (intent === 'book') {

    if (from === 'AWAITING_CONFIRMATION') return 'AWAITING_CONFIRMATION';
    return nextStateForBook(slots);
  }

  if (intent === 'confirm') {


    return from === 'AWAITING_CONFIRMATION' ? 'IDLE' : from;
  }

  if (intent === 'reschedule') {
    if (from === 'IDENTIFY_TARGET_APPOINTMENT') return 'COLLECTING_NEW_DATETIME';
    if (from === 'COLLECTING_NEW_DATETIME') return 'COLLECTING_NEW_DATETIME';
    return 'IDENTIFY_TARGET_APPOINTMENT';
  }

  if (intent === 'cancel') {
    return from === 'AWAITING_CONFIRMATION' ? 'AWAITING_CONFIRMATION' : 'IDENTIFY_TARGET_APPOINTMENT';
  }



  if (intent === 'query' || intent === 'smalltalk' || intent === 'unclear') return from;

  return from;
}

export function applyTransition(conv, toState, { actor = 'patient' } = {}) {
  if (!CONVERSATION_STATES.includes(toState)) {
    throw new Error(`Unknown conversation state: ${toState}`);
  }
  if (conv.state === toState) return null;
  const before = conv.state;
  conv.state = toState;
  return { before, after: toState, actor };
}
