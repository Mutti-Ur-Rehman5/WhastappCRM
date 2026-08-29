import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  synthesizeSpeech,
  selectTtsLanguageCode,
  GEMINI_TTS_BASE_URL,
} from '../../src/services/tts.service.js';

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

const AUDIO_PART = { inlineData: { mimeType: 'audio/L16;rate=24000', data: 'QUJD' } };

describe('selectTtsLanguageCode', () => {
  it('maps Urdu-family languages to ur-PK and everything else to en-US', () => {
    assert.equal(selectTtsLanguageCode('roman-urdu'), 'ur-PK');
    assert.equal(selectTtsLanguageCode('urdu'), 'ur-PK');
    assert.equal(selectTtsLanguageCode('sindhi'), 'ur-PK');
    assert.equal(selectTtsLanguageCode('pashto'), 'ur-PK');
    assert.equal(selectTtsLanguageCode('balochi'), 'ur-PK');
    assert.equal(selectTtsLanguageCode('english'), 'en-US');
    assert.equal(selectTtsLanguageCode(undefined), 'en-US');
  });
});

describe('synthesizeSpeech', () => {
  it('POSTs the audio-modality generateContent payload and returns the base64 PCM', async () => {
    const http = fakeHttp({
      behavior: () => ({ data: { candidates: [{ content: { parts: [AUDIO_PART] } }] } }),
    });

    const result = await synthesizeSpeech({
      text: 'Salam',
      lang: 'roman-urdu',
      http,
      apiKey: 'test-key',
      model: 'm-tts',
      voiceName: 'Kore',
    });

    assert.equal(result.mimeType, 'audio/L16;rate=24000');
    assert.equal(result.data, 'QUJD');
    assert.equal(http.calls.length, 1);
    const { url, body, config } = http.calls[0];
    assert.equal(url, '/models/m-tts:generateContent');
    assert.equal(config.headers['x-goog-api-key'], 'test-key');
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Salam' }] }]);
    assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO']);
    assert.equal(body.generationConfig.speechConfig.languageCode, 'ur-PK');
    assert.deepEqual(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig, { voiceName: 'Kore' });
  });

  it('defaults the languageCode to en-US for non-Urdu languages', async () => {
    const http = fakeHttp({ behavior: () => ({ data: { candidates: [{ content: { parts: [AUDIO_PART] } }] } }) });
    await synthesizeSpeech({ text: 'hi', lang: 'english', http, apiKey: 'k' });
    assert.equal(http.calls[0].body.generationConfig.speechConfig.languageCode, 'en-US');
  });

  it('throws a clear error when the API key is missing (no network call)', async () => {
    await assert.rejects(
      () => synthesizeSpeech({ text: 'hi', apiKey: '', http: { post: async () => ({ data: {} }) } }),
      /GEMINI_API_KEY/,
    );
  });

  it('throws when the model returns no inline audio', async () => {
    const http = fakeHttp({ behavior: () => ({ data: { candidates: [{ content: { parts: [{ text: 'no audio' }] } }] } }) });
    await assert.rejects(() => synthesizeSpeech({ text: 'hi', http, apiKey: 'k' }), /no audio/);
  });

  it('retries on 5xx then succeeds (RULES.md §4)', async () => {
    let attempt = 0;
    const http = fakeHttp({
      behavior: () => {
        attempt += 1;
        if (attempt < 2) {
          const err = new Error('upstream boom');
          err.response = { status: 503 };
          throw err;
        }
        return { data: { candidates: [{ content: { parts: [AUDIO_PART] } }] } };
      },
    });

    await synthesizeSpeech({ text: 'hi', http, apiKey: 'k', options: { baseDelayMs: 1 } });
    assert.equal(attempt, 2);
  });

  it('fails fast on 4xx without retrying', async () => {
    let attempt = 0;
    const http = fakeHttp({
      behavior: () => {
        attempt += 1;
        const err = new Error('bad key');
        err.response = { status: 401 };
        throw err;
      },
    });

    await assert.rejects(
      () => synthesizeSpeech({ text: 'hi', http, apiKey: 'k', options: { baseDelayMs: 1 } }),
      /bad key/,
    );
    assert.equal(attempt, 1);
  });
});
