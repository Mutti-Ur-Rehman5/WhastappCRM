import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import {
  AUDIO_FALLBACK_REPLY,
  getMediaMetadata,
  downloadMediaBytes,
  fetchAudioPayload,
} from '../../src/services/audioUnderstanding.service.js';
import { normalizeAudioMimeType } from '../../src/utils/media.util.js';

function fakeHttp({ behavior }) {
  const calls = [];
  return {
    calls,
    async get(url, config) {
      calls.push({ url, config });
      return behavior({ url, config });
    },
  };
}

const AUDIO_BYTES = Buffer.from('fake-opus-bytes');

describe('normalizeAudioMimeType', () => {
  it('strips codecs parameters for Gemini', () => {
    assert.equal(normalizeAudioMimeType('audio/ogg; codecs=opus'), 'audio/ogg');
    assert.equal(normalizeAudioMimeType('audio/mp4'), 'audio/mp4');
    assert.equal(normalizeAudioMimeType(''), 'audio/ogg');
  });
});

describe('getMediaMetadata', () => {
  it('GETs the media id with a bearer token and returns the download metadata', async () => {
    const meta = { url: 'https://graph.facebook.com/abc', mime_type: 'audio/ogg; codecs=opus', file_size: '123' };
    const http = fakeHttp({ behavior: () => ({ data: meta }) });

    const result = await getMediaMetadata({ mediaId: 'media.42', http });

    assert.deepEqual(result, meta);
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0].url, '/media.42');
    assert.equal(http.calls[0].config.headers.Authorization, `Bearer ${env.whatsapp.token}`);
  });

  it('retries on 5xx then succeeds (RULES.md §4)', async () => {
    let attempt = 0;
    const http = fakeHttp({
      behavior: () => {
        attempt += 1;
        if (attempt < 2) {
          const err = new Error('gateway timeout');
          err.response = { status: 502 };
          throw err;
        }
        return { data: { url: 'https://graph.facebook.com/abc' } };
      },
    });

    const result = await getMediaMetadata({ mediaId: 'media.42', http, token: 'tok' });
    assert.equal(result.url, 'https://graph.facebook.com/abc');
    assert.equal(attempt, 2);
  });

  it('fails fast on a 4xx without retrying', async () => {
    let attempt = 0;
    const http = fakeHttp({
      behavior: () => {
        attempt += 1;
        const err = new Error('invalid token');
        err.response = { status: 401 };
        throw err;
      },
    });

    await assert.rejects(() => getMediaMetadata({ mediaId: 'media.42', http }), /invalid token/);
    assert.equal(attempt, 1, '401 must not be retried');
  });
});

describe('downloadMediaBytes', () => {
  it('downloads the media as a Buffer from the absolute url', async () => {
    const http = fakeHttp({ behavior: () => ({ data: AUDIO_BYTES }) });

    const bytes = await downloadMediaBytes({ url: 'https://graph.facebook.com/abc', http });

    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.toString(), 'fake-opus-bytes');
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0].url, 'https://graph.facebook.com/abc');
    assert.equal(http.calls[0].config.responseType, 'arraybuffer');
    assert.equal(http.calls[0].config.headers.Authorization, `Bearer ${env.whatsapp.token}`);
  });
});

describe('fetchAudioPayload', () => {
  const mediaUrl = 'https://graph.facebook.com/download/abc';

  it('resolves metadata then downloads and returns base64 audio + mime type', async () => {
    const http = fakeHttp({
      behavior: ({ url }) => {
        if (url.startsWith('/media')) {
          return { data: { url: mediaUrl, mime_type: 'audio/ogg; codecs=opus' } };
        }
        return { data: AUDIO_BYTES };
      },
    });

    const payload = await fetchAudioPayload({ mediaId: 'media.1', http });

    assert.equal(payload.mimeType, 'audio/ogg; codecs=opus');
    assert.equal(payload.data, AUDIO_BYTES.toString('base64'));
    assert.equal(http.calls.length, 2, 'metadata lookup then media download');
    assert.equal(http.calls[1].url, mediaUrl);
  });

  it('falls back to the requested mime type when metadata omits one', async () => {
    const http = fakeHttp({
      behavior: ({ url }) =>
        url.startsWith('/media') ? { data: { url: mediaUrl } } : { data: AUDIO_BYTES },
    });

    const payload = await fetchAudioPayload({ mediaId: 'media.1', mimeType: 'audio/ogg', http });
    assert.equal(payload.mimeType, 'audio/ogg');
  });

  it('throws when the media metadata has no url', async () => {
    const http = fakeHttp({ behavior: () => ({ data: { mime_type: 'audio/ogg' } }) });
    await assert.rejects(() => fetchAudioPayload({ mediaId: 'media.1', http }), /missing url/);
  });

  it('throws when the downloaded bytes are empty', async () => {
    const http = fakeHttp({
      behavior: ({ url }) =>
        url.startsWith('/media') ? { data: { url: mediaUrl } } : { data: Buffer.alloc(0) },
    });
    await assert.rejects(() => fetchAudioPayload({ mediaId: 'media.1', http }), /download empty/);
  });

  it('throws when the audio exceeds the inline limit (Gemini part size)', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024 + 1);
    const http = fakeHttp({
      behavior: ({ url }) =>
        url.startsWith('/media') ? { data: { url: mediaUrl } } : { data: big },
    });
    await assert.rejects(() => fetchAudioPayload({ mediaId: 'media.1', http }), /too large/);
  });

  it('exposes a graceful fallback reply for the webhook', () => {
    assert.equal(typeof AUDIO_FALLBACK_REPLY, 'string');
    assert.ok(AUDIO_FALLBACK_REPLY.length > 20);
  });
});
