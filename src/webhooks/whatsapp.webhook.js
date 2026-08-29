import { env } from '../config/env.js';
import { MessageLog } from '../models/MessageLog.model.js';
import { enqueueInboundMessage } from '../queues/inboundMessage.queue.js';
import { normalizePhone } from '../utils/phone.util.js';
import { logger } from '../utils/logger.js';
import { sendTextMessage } from '../services/whatsapp.service.js';
import { AUDIO_FALLBACK_REPLY, fetchAudioPayload } from '../services/audioUnderstanding.service.js';
import {
  confirmReschedule,
  declineReschedule,
  parseRescheduleButtonId,
} from '../services/rescheduleConfirmation.service.js';
import { rescheduleAlreadyHandled } from '../prompts/templates.js';
import { getConversationLanguage } from '../services/localization.service.js';
import { SlotTakenError } from '../utils/errors.js';








const BOOKING_BUTTON_TEXT = {
  confirm_booking_yes: 'yes',
  confirm_booking_no: 'no',
  appointment_cancel: 'cancel',
  appointment_reschedule: 'reschedule',
};



export function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.whatsapp.verifyToken) {
    logger.info('WhatsApp webhook verified by Meta');
    res.status(200).type('text/plain').send(challenge);
    return;
  }
  logger.warn('WhatsApp webhook verification failed', { mode, requestId: req.id });
  res.sendStatus(403);
}







const defaultAudioDeps = { fetchAudioPayload, sendTextMessage };
let audioDeps = { ...defaultAudioDeps };


export function _setAudioDeps(deps) {
  audioDeps = { ...defaultAudioDeps, ...deps };
}






const defaultRescheduleDeps = {
  confirmReschedule,
  declineReschedule,
  parseRescheduleButtonId,
  sendTextMessage,
};
let rescheduleDeps = { ...defaultRescheduleDeps };


export function _setRescheduleDeps(deps) {
  rescheduleDeps = { ...defaultRescheduleDeps, ...deps };
}

async function handleRescheduleButtonReply({ phone, buttonId, waMessageId, correlationId }) {
  const log = correlationId ? logger.child({ correlationId }) : logger;
  const parsed = rescheduleDeps.parseRescheduleButtonId(buttonId);
  if (!parsed) return { handled: false };



  try {
    await MessageLog.create({ phone, direction: 'in', channel: 'whatsapp', body: buttonId, waMessageId });
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }

  try {
    const result =
      parsed.answer === 'yes'
        ? await rescheduleDeps.confirmReschedule(parsed.token, { correlationId })
        : await rescheduleDeps.declineReschedule(parsed.token, { correlationId });

    if (result?.skipped) {
      await rescheduleDeps.sendTextMessage({ to: phone, text: rescheduleAlreadyHandled(await getConversationLanguage(phone)) });
    }
    log.info('Reschedule button reply handled', { phone, answer: parsed.answer, waMessageId, skipped: result?.skipped });
    return { handled: true };
  } catch (err) {


    if (err instanceof SlotTakenError) {
      log.warn('Reschedule button reply aborted (slot lost)', { phone, answer: parsed.answer, waMessageId });
      return { handled: true, failed: true };
    }
    throw err;
  }
}




async function persistVoiceFallback({ phone, waMessageId, correlationId }) {
  const log = correlationId ? logger.child({ correlationId }) : logger;
  const outboundId = await audioDeps.sendTextMessage({ to: phone, text: AUDIO_FALLBACK_REPLY });
  try {
    await MessageLog.create({ phone, direction: 'in', channel: 'whatsapp', body: AUDIO_FALLBACK_REPLY, waMessageId });
  } catch (err) {


    if (err?.code !== 11000) throw err;
  }
  await MessageLog.create({
    phone,
    direction: 'out',
    channel: 'whatsapp',
    body: AUDIO_FALLBACK_REPLY,
    waMessageId: outboundId || undefined,
    refWaMessageId: waMessageId,
  });
  log.info('Voice note fallback reply sent', { phone, waMessageId });
}





export async function handleIncomingMessage(req, res) {
  const change = req.body?.entry?.[0]?.changes?.[0];
  const messages = change?.value?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(200).json({ status: 'ok' });
  }

  let duplicate = false;
  for (const msg of messages) {
    const { from, id: waMessageId, type } = msg;
    const isText = type === 'text' && typeof msg.text?.body === 'string' && msg.text.body !== '';
    const isAudio = type === 'audio' && typeof msg.audio?.id === 'string' && msg.audio.id !== '';
    const isButtonReply =
      type === 'interactive' &&
      msg.interactive?.type === 'button_reply' &&
      typeof msg.interactive.button_reply?.id === 'string';
    if (!waMessageId || !from || (!isText && !isAudio && !isButtonReply)) {


      logger.info('Webhook message skipped (unsupported type or missing fields)', { requestId: req.id, type });
      continue;
    }

    let phone;
    try {
      phone = normalizePhone(from);
    } catch {
      logger.warn('Webhook message skipped (invalid phone)', { requestId: req.id, from });
      continue;
    }

    const already = await MessageLog.exists({ waMessageId });
    if (already) {
      duplicate = true;
      continue;
    }





    if (isButtonReply) {
      const buttonId = msg.interactive.button_reply.id;
      const rescheduleHandled = await handleRescheduleButtonReply({
        phone,
        buttonId,
        waMessageId,
        correlationId: req.id,
      });
      if (rescheduleHandled.handled) continue;

      const mappedText = BOOKING_BUTTON_TEXT[buttonId];
      if (!mappedText) {
        logger.info('Webhook button reply skipped (unknown button id)', { requestId: req.id, phone, buttonId });
        continue;
      }
      await enqueueInboundMessage({ phone, text: mappedText, waMessageId, correlationId: req.id });
      continue;
    }

    if (isAudio) {
      if (!env.whatsapp.voiceEnabled) {
        logger.info('Webhook message skipped (voice notes disabled)', { requestId: req.id, phone });
        continue;
      }
      let payload;
      try {
        payload = await audioDeps.fetchAudioPayload({ mediaId: msg.audio.id, mimeType: msg.audio.mime_type });
        logger.info('Voice note downloaded', { requestId: req.id, phone, waMessageId });
      } catch (err) {
        logger.warn('Voice note download failed — replying with graceful fallback', {
          requestId: req.id,
          phone,
          waMessageId,
          err: err.message,
        });
        await persistVoiceFallback({ phone, waMessageId, correlationId: req.id });
        continue;
      }


      await enqueueInboundMessage({ phone, audio: payload, waMessageId, correlationId: req.id });
      continue;
    }




    await enqueueInboundMessage({ phone, text: msg.text.body, waMessageId, correlationId: req.id });
  }

  return res.status(200).json({ status: 'ok', ...(duplicate ? { duplicate: true } : {}) });
}
