import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import {
  sendTextMessage,
  sendAudioMessage,
  uploadMedia,
  isRetryableHttpError,
  GRAPH_BASE_URL,
} from '../../src/services/whatsapp.service.js';

const PHONE_ID = env.whatsapp.phoneNumberId;

function fakeHttp({ behavior }) {
  const calls = [];
  return {
    calls,
    async post(url, body, config) {
      calls.push({ url, body, config });
      return behavior({ url, body, config });
    },
  };
}

const okResponse = (id = 'wamid.out.1') => ({ data: { messages: [{ id }] } });

describe('isRetryableHttpError', () => {
  it('treats network errors, 429 and 5xx as retryable; 4xx as not', () => {
    const mk = (status) => { const e = new Error('x'); if (status) e.response = { status }; return e; };
    assert.equal(isRetryableHttpError(mk(undefined)), true);
    assert.equal(isRetryableHttpError(mk(429)), true);
    assert.equal(isRetryableHttpError(mk(500)), true);
    assert.equal(isRetryableHttpError(mk(503)), true);
    assert.equal(isRetryableHttpError(mk(400)), false);
    assert.equal(isRetryableHttpError(mk(403)), false);
  });
});

describe('sendTextMessage', () => {
  it('POSTs to the Graph send endpoint with bearer auth and correct body', async () => {
    const http = fakeHttp({ behavior: () => okResponse('wamid.out.42') });
    const id = await sendTextMessage({ to: '+923001234567', text: 'hello', http });

    assert.equal(id, 'wamid.out.42');
    assert.equal(http.calls.length, 1);
    const { url, body, config } = http.calls[0];
    assert.equal(url, `/${PHONE_ID}/messages`);
    assert.equal(GRAPH_BASE_URL, `https://graph.facebook.com/${env.whatsapp.apiVersion}`);
    assert.equal(config.headers.Authorization, `Bearer ${env.whatsapp.token}`);
    assert.deepEqual(body, {
      messaging_product: 'whatsapp',
      to: '+923001234567',
      type: 'text',
      text: { body: 'hello', preview_url: false },
    });
  });

  it('returns null when the response has no message id', async () => {
    const http = fakeHttp({ behavior: () => ({ data: {} }) });
    const id = await sendTextMessage({ to: '+923001234567', text: 'hi', http });
    assert.equal(id, null);
  });

  it('retries on 5xx then succeeds', async () => {
    let attempt = 0;
    const http = fakeHttp({
      behavior: () => {
        attempt += 1;
        if (attempt < 3) {
          const err = new Error('gateway timeout');
          err.response = { status: 502 };
          throw err;
        }
        return okResponse('wamid.out.retry');
      },
    });
    const id = await sendTextMessage({
      to: '+923001234567',
      text: 'hi',
      http,
      options: { attempts: 3, baseDelayMs: 5 },
    });
    assert.equal(id, 'wamid.out.retry');
    assert.equal(attempt, 3);
  });

  it('fails fast on 4xx without retrying', async () => {
    let attempt = 0;
    const http = fakeHttp({
      behavior: () => {
        attempt += 1;
        const err = new Error('invalid token');
        err.response = { status: 401 };
        throw err;
      },
    });
    await assert.rejects(
      () => sendTextMessage({ to: '+923001234567', text: 'hi', http, options: { attempts: 3, baseDelayMs: 5 } }),
      /invalid token/,
    );
    assert.equal(attempt, 1, '401 must not be retried');
  });
});

describe('uploadMedia', () => {
  it('POSTs a multipart form to the media endpoint with bearer auth and returns the media id', async () => {
    const http = fakeHttp({ behavior: () => ({ data: { id: 'media.42' } }) });
    const media = Buffer.from('ogg-bytes');

    const id = await uploadMedia({ type: 'audio/ogg; codecs=opus', media, filename: 'reply.ogg', http });

    assert.equal(id, 'media.42');
    assert.equal(http.calls.length, 1);
    const { url, body, config } = http.calls[0];
    assert.equal(url, `/${PHONE_ID}/media`);
    assert.equal(config.headers.Authorization, `Bearer ${env.whatsapp.token}`);
    assert.equal(body.get('messaging_product'), 'whatsapp');
    assert.equal(body.get('type'), 'audio/ogg; codecs=opus');
    assert.equal(body.get('file').size, media.length, 'raw audio bytes ride in the file part');
  });

  it('returns null when the response has no media id', async () => {
    const http = fakeHttp({ behavior: () => ({ data: {} }) });
    const id = await uploadMedia({ type: 'audio/mp3', media: Buffer.from('x'), http });
    assert.equal(id, null);
  });

  it('throws when media is not a Buffer', async () => {
    await assert.rejects(
      () => uploadMedia({ type: 'audio/mp3', media: 'not-a-buffer', http: fakeHttp({ behavior: () => ({ data: {} }) }) }),
      /requires a media type and a Buffer/,
    );
  });

  it('retries on 5xx then succeeds (RULES.md §4)', async () => {
    let attempt = 0;
    const http = fakeHttp({
      behavior: () => {
        attempt += 1;
        if (attempt < 2) {
          const err = new Error('rate limited');
          err.response = { status: 429 };
          throw err;
        }
        return { data: { id: 'media.retry' } };
      },
    });
    const id = await uploadMedia({ type: 'audio/ogg; codecs=opus', media: Buffer.from('x'), http, options: { attempts: 3, baseDelayMs: 5 } });
    assert.equal(id, 'media.retry');
    assert.equal(attempt, 2);
  });
});

describe('sendAudioMessage', () => {
  it('POSTs the audio payload with voice: true and returns the outbound id', async () => {
    const http = fakeHttp({ behavior: () => okResponse('wamid.audio.1') });

    const id = await sendAudioMessage({ to: '+923001234567', mediaId: 'media.42', http });

    assert.equal(id, 'wamid.audio.1');
    assert.equal(http.calls.length, 1);
    const { url, body, config } = http.calls[0];
    assert.equal(url, `/${PHONE_ID}/messages`);
    assert.equal(config.headers.Authorization, `Bearer ${env.whatsapp.token}`);
    assert.deepEqual(body, {
      messaging_product: 'whatsapp',
      to: '+923001234567',
      type: 'audio',
      audio: { id: 'media.42', voice: true },
    });
  });

  it('throws when no media id is provided', async () => {
    await assert.rejects(
      () => sendAudioMessage({ to: '+923001234567', mediaId: '', http: fakeHttp({ behavior: () => okResponse() }) }),
      /requires a mediaId/,
    );
  });
});
