import axios from 'axios';
import { env } from '../config/env.js';
import { withRetry } from '../utils/retry.util.js';
import { isRetryableHttpError } from './whatsapp.service.js';
import { LANG } from './localization.service.js';

export const GEMINI_TTS_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';




export const ttsHttp = axios.create({
  baseURL: GEMINI_TTS_BASE_URL,
  timeout: 30_000,
});




const URDU_LIKE_LOCALE = 'ur-PK';
const DEFAULT_LOCALE = 'en-US';

export function selectTtsLanguageCode(lang) {
  const urduLike = new Set([
    LANG.URDU,
    LANG.ROMAN_URDU,
    LANG.SINDHI,
    LANG.ROMAN_SINDHI,
    LANG.PASHTO,
    LANG.ROMAN_PASHTO,
    LANG.BALOCHI,
    LANG.ROMAN_BALOCHI,
  ]);
  return urduLike.has(lang) ? URDU_LIKE_LOCALE : DEFAULT_LOCALE;
}

export async function synthesizeSpeech({
  text,
  lang,
  http = ttsHttp,
  apiKey = env.geminiApiKey,
  model = env.geminiTtsModel,
  voiceName = env.geminiTtsVoice,
  options = {},
}) {
  if (!apiKey) {
    throw new Error('Gemini API key not configured (GEMINI_API_KEY)');
  }

  const response = await withRetry(
    () =>
      http.post(
        `/models/${model}:generateContent`,
        {
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              languageCode: selectTtsLanguageCode(lang),
              voiceConfig: { prebuiltVoiceConfig: { voiceName } },
            },
          },
        },
        { headers: { 'x-goog-api-key': apiKey } },
      ),
    {
      attempts: options.attempts ?? 3,
      baseDelayMs: options.baseDelayMs ?? 200,
      shouldRetry: isRetryableHttpError,
      context: { kind: 'gemini-tts' },
    },
  );

  const part = response?.data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part?.inlineData?.data) {
    throw new Error('Gemini TTS returned no audio (missing inlineData)');
  }
  return {
    mimeType: part.inlineData.mimeType || 'audio/L16;rate=24000',
    data: part.inlineData.data,
  };
}
