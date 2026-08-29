import axios from 'axios';
import { env } from '../config/env.js';
import { withRetry } from '../utils/retry.util.js';

export const GRAPH_BASE_URL = `https://graph.facebook.com/${env.whatsapp.apiVersion}`;



export const graphClient = axios.create({
  baseURL: GRAPH_BASE_URL,
  timeout: 15_000,
});



export function isRetryableHttpError(err) {
  if (!err.response) return true;
  return err.response.status === 429 || err.response.status >= 500;
}

export async function sendTextMessage({ to, text, http = graphClient, options = {} }) {
  const { token, phoneNumberId } = env.whatsapp;
  if (!token || !phoneNumberId) {
    throw new Error('WhatsApp credentials not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
  }

  const response = await withRetry(
    () =>
      http.post(`/${phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text, preview_url: false },
      }, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    {
      attempts: options.attempts ?? 3,
      baseDelayMs: options.baseDelayMs ?? 200,
      shouldRetry: (err) => isRetryableHttpError(err),
      context: { phone: to },
    },
  );

  return response?.data?.messages?.[0]?.id ?? null;
}

export async function uploadMedia({ type, media, filename = 'audio', http = graphClient, options = {} }) {
  const { token, phoneNumberId } = env.whatsapp;
  if (!token || !phoneNumberId) {
    throw new Error('WhatsApp credentials not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
  }
  if (!type || !Buffer.isBuffer(media)) {
    throw new Error('uploadMedia requires a media type and a Buffer');
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', type);


  form.append('file', new Blob([media], { type }), filename);

  const response = await withRetry(
    () =>
      http.post(`/${phoneNumberId}/media`, form, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    {
      attempts: options.attempts ?? 3,
      baseDelayMs: options.baseDelayMs ?? 200,
      shouldRetry: (err) => isRetryableHttpError(err),
      context: { kind: 'media-upload' },
    },
  );

  return response?.data?.id ?? null;
}

export async function sendAudioMessage({ to, mediaId, voice = true, http = graphClient, options = {} }) {
  const { token, phoneNumberId } = env.whatsapp;
  if (!token || !phoneNumberId) {
    throw new Error('WhatsApp credentials not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
  }
  if (!mediaId) {
    throw new Error('sendAudioMessage requires a mediaId from a prior uploadMedia call');
  }

  const response = await withRetry(
    () =>
      http.post(
        `/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'audio',
          audio: { id: mediaId, voice },
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
    {
      attempts: options.attempts ?? 3,
      baseDelayMs: options.baseDelayMs ?? 200,
      shouldRetry: (err) => isRetryableHttpError(err),
      context: { phone: to, kind: 'audio-message' },
    },
  );

  return response?.data?.messages?.[0]?.id ?? null;
}

export async function sendPatientMessage({ to, text, buttons, http, options } = {}) {
  if (Array.isArray(buttons) && buttons.length > 0) {
    return sendInteractiveButtons({ to, body: text, buttons, http, options });
  }
  return sendTextMessage({ to, text, http, options });
}

export async function sendInteractiveButtons({ to, body, buttons, header, http = graphClient, options = {} }) {
  const { token, phoneNumberId } = env.whatsapp;
  if (!token || !phoneNumberId) {
    throw new Error('WhatsApp credentials not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
  }
  if (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > 3) {
    throw new Error('sendInteractiveButtons requires 1-3 buttons');
  }

  const interactive = {
    type: 'button',
    body: { text: body },
    action: {
      buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
    },
  };
  if (header) interactive.header = { type: 'text', text: header };

  const response = await withRetry(
    () =>
      http.post(`/${phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive,
      }, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    {
      attempts: options.attempts ?? 3,
      baseDelayMs: options.baseDelayMs ?? 200,
      shouldRetry: (err) => isRetryableHttpError(err),
      context: { phone: to, kind: 'interactive-buttons' },
    },
  );

  return response?.data?.messages?.[0]?.id ?? null;
}
