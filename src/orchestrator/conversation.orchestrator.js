import { MessageLog } from '../models/MessageLog.model.js';
import { Patient } from '../models/Patient.model.js';
import {
  appendAssistantTurn,
  appendUserTurn,
  persistConversation,
  readConversation,
} from '../services/conversation.memory.service.js';
import { logAuditMany } from '../services/audit.service.js';
import { understandMessage, VOICE_NOTE_MARKER, classifyInfraError } from '../services/nlu.service.js';
import { detectLanguage, pickLanguage, localized } from '../services/localization.service.js';
import { sendPatientMessage } from '../services/whatsapp.service.js';
import { sendVoiceReplyWithTextFallback } from '../services/voiceReply.service.js';
import { todayInClinicTimeZone } from '../utils/datetime.util.js';
import { logger } from '../utils/logger.js';
import { LockUnavailableError, ValidationError } from '../utils/errors.js';
import { applyTransition } from './stateMachine.js';
import {
  noopEnqueueSheetSync,
  noopEnqueueNotifyDoctor,
  noopEnqueueNotifyPatientConfirmation,
  noopEnqueueScheduleReminders,
  noopRemoveReminderJobs,
} from '../services/booking.service.js';
import { handleBookIntent, handleConfirmIntent, buildUnavailableReply, findAutoSlot, confirmSummary, DECLINED_REPLY } from './intents/book.intent.js';
import { confirmButtons } from '../services/localization.service.js';
import { handleRescheduleIntent, handleRescheduleConfirm } from './intents/reschedule.intent.js';
import { handleCancelIntent, handleCancelConfirm } from './intents/cancel.intent.js';
import { handleAvailabilityIntent, handleQueryAppointmentsIntent } from './intents/query.intent.js';
import { checkSlotBookable } from '../services/booking.service.js';
import { findNearestAvailable } from '../services/suggestion.service.js';
import { getDoctorConfig } from '../services/slot.service.js';
import { setSlotHold, releaseSlotHold } from '../services/slotHold.service.js';

export const SMALLTALK_DEFAULT_REPLY =
  "hello, I'm the clinic assistant — I can help you book, reschedule, or check your appointments.";
export const UNCLEAR_REPLY = 'Sorry, I did not understand. Please rephrase or type MENU.';
export const NLU_FALLBACK_REPLY = 'Sorry, I did not understand. Please rephrase or type MENU.';
export const VOICE_UNCLEAR_REPLY =
  "Sorry, I couldn't catch that clearly. Please say it again a bit slowly, or type your message.";
export const VOICE_GUIDED_REPLY =
  "I can help you book an appointment. Please tell me your name, or type MENU for options.";
export const VOICE_UNAVAILABLE_REPLY =
  "Sorry, I can't process voice messages right now. Please type your message and I'll help you.";
export const INTENT_STUB_REPLY =
  'I can help you book a new appointment for now — other options are coming soon.';
export const LOCK_BUSY_REPLY =
  'System is busy right now — please try again in a moment.';
export const GENERIC_ERROR_REPLY =
  'Something went wrong on our side — please try again shortly, or contact the clinic.';

function routeToolCall(name) {
  switch (name) {
    case 'book_appointment':
      return 'book';
    case 'confirm':
      return 'confirm';
    case 'smalltalk_or_unclear':
      return 'smalltalk';
    case 'query_my_appointments':
      return 'query';
    case 'reschedule_appointment':
      return 'reschedule';
    case 'cancel_appointment':
      return 'cancel';
    case 'check_availability':
      return 'availability';
    default:
      return 'smalltalk';
  }
}

async function handleConfirmForIntent({
  conv,
  value,
  doctorConfig,
  enqueueSheetSync,
  enqueueNotifyDoctor,
  enqueueNotifyPatientConfirmation,
  enqueueScheduleReminders,
  removeReminderJobs,
  correlationId,
}) {
  switch (conv.pendingIntent) {
    case 'reschedule':
      return handleRescheduleConfirm({
        conv,
        value,
        doctorConfig,
        enqueueSheetSync,
        enqueueNotifyDoctor,
        enqueueScheduleReminders,
        removeReminderJobs,
        correlationId,
      });
    case 'cancel':
      return handleCancelConfirm({
        conv,
        value,
        enqueueSheetSync,
        enqueueNotifyDoctor,
        removeReminderJobs,
        correlationId,
      });
    default:
      return handleConfirmIntent({
        conv,
        value,
        doctorConfig,
        enqueueSheetSync,
        enqueueNotifyDoctor,
        enqueueNotifyPatientConfirmation,
        enqueueScheduleReminders,
        correlationId,
      });
  }
}

async function guardUnavailableSlot({ conv, config, excludeAppointmentId, collectingState }) {
  const { date, time } = conv.slots || {};
  if (!date || !time) return null;

  const check = await checkSlotBookable({ doctorId: config._id, date, time, config, excludeAppointmentId });
  if (check.ok) return null;

  const alternatives = await findNearestAvailable(config._id, date, time, 3, { config });
  return {
    slots: { ...conv.slots, date: undefined, time: undefined },
    nextState: collectingState,
    reply: buildUnavailableReply(date, time, check.reason, alternatives, conv.language),
  };
}

export async function handleInbound({ phone, text, media, waMessageId }, deps = {}) {
  const {
    nlu = understandMessage,
    sendMessage = sendPatientMessage,
    sendVoiceMessage = sendVoiceReplyWithTextFallback,
    todayRef = todayInClinicTimeZone(),
    doctorConfig,
    enqueueSheetSync = noopEnqueueSheetSync,
    enqueueNotifyDoctor = noopEnqueueNotifyDoctor,
    enqueueNotifyPatientConfirmation = noopEnqueueNotifyPatientConfirmation,
    enqueueScheduleReminders = noopEnqueueScheduleReminders,
    removeReminderJobs = noopRemoveReminderJobs,
    correlationId,
  } = deps;



  const log = correlationId ? logger.child({ correlationId }) : logger;

  const alreadyReplied = await MessageLog.exists({ refWaMessageId: waMessageId, direction: 'out' });
  if (alreadyReplied) {
    return { ok: true, duplicate: true, reply: null, state: null };
  }

  const conv = await readConversation(phone);




  const userBody = text ?? (media ? VOICE_NOTE_MARKER : '');
  appendUserTurn(conv, userBody, { waMessageId });
  conv.lastMessageAt = new Date();






  if (text) conv.language = pickLanguage(detectLanguage(text), conv.language);

  const lang = conv.language;


  const L = (id, fallback) => localized(id, lang) ?? fallback;

  let toolCall;
  let transcript;
  try {
    const result = await nlu({
      phone,
      history: conv.history,
      slots: conv.slots,
      todayRef,
      state: conv.state,
      media,
      language: conv.language,
    });
    toolCall = result.toolCall;
    transcript = result.transcript;
  } catch (err) {




    const errClass = classifyInfraError(err);
    log.error('NLU failed, replying with fallback', { phone, waMessageId, err: err.message, errClass, hasMedia: Boolean(media) });
    if (media) {
      toolCall = {
        name: 'smalltalk_or_unclear',
        input: { replyHint: L('smalltalk.default', SMALLTALK_DEFAULT_REPLY) },
        voiceUnavailable: true,
        voiceUnavailableReason: errClass,
      };
    } else {
      toolCall = { name: 'smalltalk_or_unclear', input: { replyHint: L('unclear', NLU_FALLBACK_REPLY) } };
    }
  }
  if (transcript) conv.language = pickLanguage(detectLanguage(transcript), conv.language);

  const intent = routeToolCall(toolCall.name);
  const transitions = [];
  let reply;
  let buttons;

  if (intent === 'book') {
    conv.pendingIntent = 'book';






    for (const key of ['name', 'reason']) {
      if (toolCall.input?.[key] && String(toolCall.input[key]).trim() === VOICE_NOTE_MARKER) {
        log.warn('NLU returned the voice-note marker as a field — ignoring it', { phone, key });
        toolCall.input[key] = undefined;
      }
    }



    if (!toolCall.input?.name && !conv.slots?.name) {
      const existing = await Patient.findOne({ phone: conv.phone }).select('name').lean();
      if (existing?.name) toolCall.input = { ...toolCall.input, name: existing.name };
    }
    const result = await handleBookIntent({ conv, input: toolCall.input });
    log.debug('book intent handled', { phone, input: toolCall.input, slotsAfterMerge: conv.slots, missing: result.missing });
    conv.slots = result.slots;
    let nextState = result.nextState;
    let pendingReply = result.reply;
    let pendingButtons = result.buttons;





    if (nextState === 'AWAITING_CONFIRMATION') {
      const config = doctorConfig || (await getDoctorConfig());
      if (config) {
        if (toolCall.input?.date || toolCall.input?.time) {

          const guard = await guardUnavailableSlot({ conv, config, collectingState: 'COLLECTING_DATETIME' });
          if (guard) {
            conv.slots = guard.slots;
            nextState = guard.nextState;
            pendingReply = guard.reply;
            pendingButtons = undefined;
          }
        } else if (!conv.slots.date || !conv.slots.time) {

          const autoSlot = await findAutoSlot(config._id, { config, todayRef: todayInClinicTimeZone() });
          if (autoSlot) {
            conv.slots.date = autoSlot.date;
            conv.slots.time = autoSlot.time;


            await setSlotHold({ doctorId: config._id, date: autoSlot.date, time: autoSlot.time, phone });
            pendingReply = confirmSummary(conv.slots, conv.language);
            pendingButtons = confirmButtons(conv.language);
          } else {
            pendingReply = NO_SLOT_REPLY;
            nextState = 'IDLE';
            pendingButtons = undefined;
          }
        }
      }
    }
    const transition = applyTransition(conv, nextState, { actor: 'patient' });
    if (transition) transitions.push(transition);
    reply = pendingReply;
    buttons = pendingButtons;
  } else if (intent === 'confirm') {
    log.info('confirm handler entered', {
      phone, state: conv.state, pendingIntent: conv.pendingIntent,
      confirmValue: toolCall.input?.value,
    });
    if (conv.state === 'AWAITING_CONFIRMATION') {
      const confirmValue = toolCall.input?.value === true;




      if (conv.pendingIntent === 'book' && confirmValue === false) {
        log.info('BOOK DECLINE — patient declined, ending booking attempt', {
          phone, currentDate: conv.slots?.date, currentTime: conv.slots?.time,
        });

        if (conv.slots?.date && conv.slots?.time) {
          const doctorIdForHold = doctorConfig?._id || (await getDoctorConfig())?._id;
          if (doctorIdForHold) {
            await releaseSlotHold({ doctorId: doctorIdForHold, date: conv.slots.date, time: conv.slots.time, phone });
          }
        }
        const transition = applyTransition(conv, 'IDLE', { actor: 'patient' });
        if (transition) transitions.push(transition);
        conv.pendingIntent = null;
        conv.slots = { phone: conv.phone };
        reply = L('book.declined', DECLINED_REPLY);
      } else {

        let result;
        try {
          result = await handleConfirmForIntent({
            conv,
            value: confirmValue,
            doctorConfig,
            enqueueSheetSync,
            enqueueNotifyDoctor,
            enqueueNotifyPatientConfirmation,
            enqueueScheduleReminders,
            removeReminderJobs,
            correlationId,
          });
        } catch (err) {
          if (err instanceof LockUnavailableError || err instanceof ValidationError) {
            result = {
              reply: err instanceof LockUnavailableError ? L('busy', LOCK_BUSY_REPLY) : L('unclear', UNCLEAR_REPLY),
              nextState: 'AWAITING_CONFIRMATION',
              clearSlots: false,
              clearIntent: false,
            };
          } else {
            log.error('Unexpected error during confirmation', {
              phone,
              waMessageId,
              intent: conv.pendingIntent,
              err: { message: err.message, stack: err.stack },
            });
            result = {
              reply: L('error', GENERIC_ERROR_REPLY),
              nextState: 'AWAITING_CONFIRMATION',
              clearSlots: false,
              clearIntent: false,
            };
          }
        }
        const transition = applyTransition(conv, result.nextState, { actor: 'patient' });
        if (transition) transitions.push(transition);
        if (result.clearSlots) {

          if (conv.slots?.date && conv.slots?.time) {
            const doctorIdForHold = doctorConfig?._id || (await getDoctorConfig())?._id;
            if (doctorIdForHold) {
              await releaseSlotHold({ doctorId: doctorIdForHold, date: conv.slots.date, time: conv.slots.time, phone });
            }
          }
          conv.pendingIntent = null;
          conv.slots = { phone: conv.phone };
        }
        reply = result.reply;
        buttons = result.buttons;
      }
    } else {
      reply = L('unclear', UNCLEAR_REPLY);
    }
  } else if (intent === 'reschedule') {
    conv.pendingIntent = 'reschedule';
    const result = await handleRescheduleIntent({ conv, input: toolCall.input });
    conv.slots = result.slots;
    let nextState = result.nextState;
    let pendingReply = result.reply;
    let pendingButtons = result.buttons;


    if (nextState === 'AWAITING_CONFIRMATION' && (toolCall.input?.newDate || toolCall.input?.newTime)) {
      const config = doctorConfig || (await getDoctorConfig());
      if (config) {
        const guard = await guardUnavailableSlot({
          conv,
          config,
          excludeAppointmentId: conv.slots.targetAppointmentId,
          collectingState: 'COLLECTING_NEW_DATETIME',
        });
        if (guard) {
          conv.slots = guard.slots;
          nextState = guard.nextState;
          pendingReply = guard.reply;
          pendingButtons = undefined;
        }
      }
    }
    const transition = applyTransition(conv, nextState, { actor: 'patient' });
    if (transition) transitions.push(transition);
    if (result.clearSlots) {
      conv.pendingIntent = null;
      conv.slots = { phone: conv.phone };
    }
    reply = pendingReply;
    buttons = pendingButtons;
  } else if (intent === 'cancel') {
    conv.pendingIntent = 'cancel';
    const result = await handleCancelIntent({ conv, input: toolCall.input });
    conv.slots = result.slots;
    const transition = applyTransition(conv, result.nextState, { actor: 'patient' });
    if (transition) transitions.push(transition);
    if (result.clearSlots) {
      conv.pendingIntent = null;
      conv.slots = { phone: conv.phone };
    }
    reply = result.reply;
  } else if (intent === 'availability') {


    const config = doctorConfig || (await getDoctorConfig());
    const result = await handleAvailabilityIntent({ conv, input: toolCall.input, config });
    const transition = applyTransition(conv, result.nextState, { actor: 'patient' });
    if (transition) transitions.push(transition);
    reply = result.reply;
  } else if (intent === 'query') {

    const result = await handleQueryAppointmentsIntent({ conv });
    const transition = applyTransition(conv, result.nextState, { actor: 'patient' });
    if (transition) transitions.push(transition);
    reply = result.reply;
  } else if (intent === 'smalltalk') {



    if (toolCall.input?.replyHint === 'unclear_confirm' && conv.state === 'AWAITING_CONFIRMATION') {
      reply = L('book.confirm', confirmSummary(conv.slots, conv.language));
      buttons = confirmButtons(conv.language);
    } else {
      reply = toolCall.input?.replyHint || L('smalltalk.default', SMALLTALK_DEFAULT_REPLY);











      log.debug('smalltalk handler', {
        phone, intent, state: conv.state, hasMedia: Boolean(media),
        replyPreview: (reply || '').slice(0, 100), replyHint: toolCall.input?.replyHint,
        transcript: transcript?.slice(0, 120),
      });
      if (media && reply === NLU_FALLBACK_REPLY) {
        if (toolCall.voiceUnavailable) {






          log.warn('voice_infra_error_fallback', {
            phone,
            waMessageId,
            reason: toolCall.voiceUnavailableReason || 'unknown',
          });
          reply = L('voice.unavailable', VOICE_UNAVAILABLE_REPLY);
        } else {




          log.warn('voice_genuine_unclear_fallback', {
            phone,
            waMessageId,
            transcript,
            replyHint: toolCall.input?.replyHint,
          });
          reply = L('voice.guided', VOICE_GUIDED_REPLY);
        }
      }
    }
  } else {
    log.warn('Intent not yet implemented', { phone, intent });
    reply = L('stub', INTENT_STUB_REPLY);
  }










  const shouldAttemptVoice = media && !toolCall.voiceUnavailable;






  const lastAssistantTurn = [...conv.history].reverse().find((t) => t.role === 'assistant');
  if (intent === 'confirm' && conv.state === 'AWAITING_CONFIRMATION' && lastAssistantTurn && lastAssistantTurn.text === reply) {
    log.warn('Possible confirmation loop detected — same reply sent twice in a row without state change', {
      phone, replyPreview: (reply || '').slice(0, 100), state: conv.state, intent,
    });
  }

  const outboundId = await (shouldAttemptVoice ? sendVoiceMessage : sendMessage)({
    to: phone,
    text: reply,
    buttons,
    lang: conv.language,
  });
  await MessageLog.create({
    phone,
    direction: 'out',
    channel: 'whatsapp',
    body: reply,
    waMessageId: outboundId || undefined,
    refWaMessageId: waMessageId,
  });




  if (transcript) {
    const lastUserTurn = [...conv.history].reverse().find((turn) => turn.role === 'user');
    if (lastUserTurn && lastUserTurn.text === VOICE_NOTE_MARKER) lastUserTurn.text = transcript;
  }

  appendAssistantTurn(conv, reply, { refWaMessageId: waMessageId });
  await persistConversation(conv);
  await logAuditMany(
    transitions.map((t) => ({
      entity: 'conversation',
      entityId: conv._id,
      action: `state:${t.before}->${t.after}`,
      actor: t.actor,
      before: { state: t.before },
      after: { state: t.after },
    })),
  );

  log.info('Inbound turn processed', { phone, waMessageId, intent, state: conv.state, replyLength: reply?.length ?? 0, transcript: transcript?.slice(0, 120) });

  return { ok: true, state: conv.state, intent, toolCall, reply };
}
