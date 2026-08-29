import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { synthesizeSpeech, ttsHttp } from './tts.service.js';
import { transcodeToWhatsAppAudio, parsePcmFormat, WHATSAPP_VOICE_MIME_TYPE } from '../utils/audio.util.js';
import { uploadMedia, sendAudioMessage, sendPatientMessage, graphClient } from './whatsapp.service.js';
import { classifyInfraError } from './nlu.service.js';





export const MIN_TTS_AUDIO_SECONDS = 0.5;

export function parseUnsupportedLanguages(raw = '') {
  const textOnly = new Set();
  const attemptWithFallback = new Set();
  for (const entry of String(raw || '').split(',')) {
    let name = entry.trim().toLowerCase();
    if (!name) continue;
    if (name.startsWith('!')) {
      name = name.slice(1).trim();
      if (name) textOnly.add(name);
    } else {
      attemptWithFallback.add(name);
    }
  }
  return { textOnly, attemptWithFallback };
}

export function languageKey(lang) {
  return String(lang || '').toLowerCase().replace(/^roman-/, '');
}


export function pcmDurationSeconds(data, mimeType = 'audio/L16;rate=24000') {
  const bytes = Buffer.from(data || '', 'base64').length;
  if (bytes === 0) return 0;
  const { sampleRate, channels, sampleWidth } = parsePcmFormat(mimeType);
  return bytes / (sampleRate * channels * sampleWidth);
}

export async function sendVoiceReply({
  to,
  text,
  lang,
  http = graphClient,
  tts = ttsHttp,
  guardShortAudio = false,
  minAudioSeconds = MIN_TTS_AUDIO_SECONDS,
  options = {},
}) {
  const { mimeType, data } = await synthesizeSpeech({ text, lang, http: tts, options });

  const audioDurationSec = pcmDurationSeconds(data, mimeType);
  if (guardShortAudio && audioDurationSec < minAudioSeconds) {
    throw new Error(`Gemini TTS audio too short (${audioDurationSec.toFixed(3)}s) for language "${lang}"`);
  }

  const pcm = Buffer.from(data, 'base64');
  const ogg = await transcodeToWhatsAppAudio({ pcm, sourceMimeType: mimeType });

  const mediaId = await uploadMedia({ type: WHATSAPP_VOICE_MIME_TYPE, media: ogg, filename: 'reply.ogg', http, options });
  if (!mediaId) {
    throw new Error('WhatsApp media upload returned no media id');
  }

  const outboundId = await sendAudioMessage({ to, mediaId, voice: true, http, options });

  logger.info('Voice reply generated', {
    phone: to,
    lang,
    audioDurationSec: Number(audioDurationSec.toFixed(3)),
    outcome: 'voice',
  });
  return outboundId;
}

export async function sendVoiceReplyWithTextFallback({
  to,
  text,
  buttons,
  lang,
  tryVoice = sendVoiceReply,
  sendText = sendPatientMessage,
  unsupportedLanguages = env.voiceReplyUnsupportedLanguages,
  ...rest
}) {
  const { textOnly, attemptWithFallback } = parseUnsupportedLanguages(unsupportedLanguages);
  const base = languageKey(lang);

  if (textOnly.has(base)) {
    logger.info('Voice reply skipped — text-only language', { phone: to, lang });
    return sendText({ to, text, buttons });
  }

  const guardShortAudio = attemptWithFallback.has(base);

  try {
    return await tryVoice({ to, text, lang, guardShortAudio, ...rest });
  } catch (err) {
    logger.warn('Voice reply failed — falling back to text', {
      phone: to,
      lang,
      guardShortAudio,
      errClass: classifyInfraError(err),
      err: { message: err.message, status: err.response?.status },
    });
    return sendText({ to, text, buttons });
  }
}
