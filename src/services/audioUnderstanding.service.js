import { env } from '../config/env.js';
import { graphClient, isRetryableHttpError } from './whatsapp.service.js';
import { withRetry } from '../utils/retry.util.js';
import { logger } from '../utils/logger.js';










export const AUDIO_FALLBACK_REPLY =
  "Sorry, I couldn't hear your voice note. Please type your message instead.";




const MAX_INLINE_AUDIO_BYTES = 20 * 1024 * 1024;

export async function getMediaMetadata({ mediaId, http = graphClient, token = env.whatsapp.token }) {
  const response = await withRetry(
    () => http.get(`/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } }),
    { attempts: 3, baseDelayMs: 200, shouldRetry: isRetryableHttpError, context: { service: 'whatsapp-media' } },
  );
  return response.data;
}

export async function downloadMediaBytes({ url, http = graphClient, token = env.whatsapp.token }) {
  const response = await withRetry(
    () => http.get(url, { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' }),
    { attempts: 3, baseDelayMs: 200, shouldRetry: isRetryableHttpError, context: { service: 'whatsapp-media-download' } },
  );
  return Buffer.from(response.data);
}

export async function fetchAudioPayload({ mediaId, mimeType, http }) {
  const metadata = await getMediaMetadata({ mediaId, http });
  if (!metadata?.url) throw new Error('WhatsApp media metadata missing url');

  logger.info('Voice metadata fetched', { mediaId, reportedMimeType: metadata.mime_type || mimeType, url: metadata.url ? 'present' : 'missing' });

  const bytes = await downloadMediaBytes({ url: metadata.url, http });
  if (bytes.length === 0) throw new Error('WhatsApp media download empty');
  if (bytes.length > MAX_INLINE_AUDIO_BYTES) {
    throw new Error(`Voice note too large for inline transcription (${bytes.length} bytes)`);
  }

  const resolvedMimeType = metadata.mime_type || mimeType || 'audio/ogg';
  logger.info('Voice audio downloaded', { mediaId, byteSize: bytes.length, resolvedMimeType });
  return { mimeType: resolvedMimeType, data: bytes.toString('base64') };
}
