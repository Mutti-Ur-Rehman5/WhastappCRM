import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendVoiceReply,
  sendVoiceReplyWithTextFallback,
  parseUnsupportedLanguages,
  languageKey,
  pcmDurationSeconds,
  MIN_TTS_AUDIO_SECONDS,
} from '../../src/services/voiceReply.service.js';

describe('parseUnsupportedLanguages', () => {
  it('splits a plain list into the attempt-with-fallback set', () => {
    const { textOnly, attemptWithFallback } = parseUnsupportedLanguages('punjabi,sindhi,balochi');
    assert.deepEqual([...attemptWithFallback].sort(), ['balochi', 'punjabi', 'sindhi']);
    assert.equal(textOnly.size, 0);
  });

  it('moves `!`-prefixed entries into the text-only set', () => {
    const { textOnly, attemptWithFallback } = parseUnsupportedLanguages('!punjabi,sindhi');
    assert.deepEqual([...textOnly], ['punjabi']);
    assert.deepEqual([...attemptWithFallback], ['sindhi']);
  });

  it('ignores empty entries and trims whitespace/case', () => {
    const { textOnly, attemptWithFallback } = parseUnsupportedLanguages('  PUNJABI ,, ! Sindhi ,');
    assert.deepEqual([...textOnly], ['sindhi']);
    assert.deepEqual([...attemptWithFallback], ['punjabi']);
  });
});

describe('languageKey', () => {
  it('maps roman variants to their plain base name', () => {
    assert.equal(languageKey('roman-sindhi'), 'sindhi');
    assert.equal(languageKey('roman-balochi'), 'balochi');
    assert.equal(languageKey('roman-pashto'), 'pashto');
    assert.equal(languageKey('urdu'), 'urdu');
    assert.equal(languageKey('english'), 'english');
    assert.equal(languageKey(undefined), '');
  });
});

describe('pcmDurationSeconds', () => {
  it('computes duration from base64 PCM bytes and the mime sample rate', () => {
    // 1 second at 24000Hz mono 16-bit = 48000 bytes.
    const data = Buffer.alloc(24000 * 2, 0).toString('base64');
    assert.equal(pcmDurationSeconds(data, 'audio/L16;rate=24000'), 1);
    assert.equal(pcmDurationSeconds('', 'audio/L16;rate=24000'), 0);
  });
});

describe('sendVoiceReply (TTS → transcode → upload → send)', () => {
  it('runs the full pipeline and returns the WhatsApp outbound id', async () => {
    const calls = [];
    const http = {
      async post(url) {
        if (url.endsWith('/media')) {
          calls.push('upload');
          return { data: { id: 'media.42' } };
        }
        if (url.endsWith('/messages')) {
          calls.push('send');
          return { data: { messages: [{ id: 'wamid.voice.1' }] } };
        }
        throw new Error(`unexpected url: ${url}`);
      },
    };
    const tts = {
      async post() {
        calls.push('tts');
        return {
          data: {
            candidates: [
              {
                content: {
                  parts: [
                    { inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(24000 * 2, 0).toString('base64') } },
                  ],
                },
              },
            ],
          },
        };
      },
    };

    const id = await sendVoiceReply({ to: '+923001234567', text: 'hi', lang: 'english', http, tts });

    assert.equal(id, 'wamid.voice.1');
    assert.deepEqual(calls, ['tts', 'upload', 'send'], 'stages run in order');
  });

  it('throws when the upload returns no media id', async () => {
    const http = {
      async post(url) {
        if (url.endsWith('/media')) return { data: {} };
        throw new Error('should not reach send');
      },
    };
    const tts = {
      async post() {
        return { data: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(4, 0).toString('base64') } }] } }] } };
      },
    };
    await assert.rejects(
      () => sendVoiceReply({ to: '+923001234567', text: 'hi', http, tts }),
      /no media id/,
    );
  });

  it('passes the patient language and the text unmodified into TTS (RULES.md §4)', async () => {
    let ttsBody;
    const http = {
      async post(url, _body) {
        if (url.endsWith('/media')) return { data: { id: 'media.1' } };
        if (url.endsWith('/messages')) return { data: { messages: [{ id: 'wamid.1' }] } };
        throw new Error(`unexpected url: ${url}`);
      },
    };
    const tts = {
      async post(_url, body) {
        ttsBody = body;
        return { data: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(24000 * 2, 0).toString('base64') } }] } }] } };
      },
    };
    const pashtoText = 'ستاسو اپاینټمنټ تایید شوه';

    await sendVoiceReply({ to: '+92', text: pashtoText, lang: 'pashto', http, tts });

    assert.equal(ttsBody.contents[0].parts[0].text, pashtoText, 'text goes to TTS verbatim, no translate/transliterate');
    assert.equal(ttsBody.generationConfig.speechConfig.languageCode, 'ur-PK');
  });

  it('rejects audio below minAudioSeconds when guardShortAudio is on', async () => {
    const tts = {
      async post() {
        return { data: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(4, 0).toString('base64') } }] } }] } };
      },
    };
    await assert.rejects(
      () => sendVoiceReply({ to: '+92', text: 'hi', lang: 'sindhi', tts, guardShortAudio: true }),
      /audio too short/,
    );
  });

  it('accepts audio above the threshold when guardShortAudio is on', async () => {
    const http = {
      async post(url) {
        if (url.endsWith('/media')) return { data: { id: 'media.1' } };
        if (url.endsWith('/messages')) return { data: { messages: [{ id: 'wamid.1' }] } };
        throw new Error(`unexpected url: ${url}`);
      },
    };
    const tts = {
      async post() {
        return { data: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(24000 * 2, 0).toString('base64') } }] } }] } };
      },
    };
    const id = await sendVoiceReply({ to: '+92', text: 'hi', lang: 'sindhi', http, tts, guardShortAudio: true });
    assert.equal(id, 'wamid.1');
  });
});

describe('sendVoiceReplyWithTextFallback', () => {
  it('returns the voice message id on success', async () => {
    const id = await sendVoiceReplyWithTextFallback({
      to: '+92',
      text: 'hi',
      lang: 'english',
      tryVoice: async ({ to, text, lang }) => `voice:${to}:${lang}:${text}`,
      sendText: async () => 'should-not-be-called',
    });
    assert.equal(id, 'voice:+92:english:hi');
  });

  it('falls back to text (buttons included) when the voice pipeline throws', async () => {
    const buttons = [{ id: 'yes', title: 'Yes' }];
    let textSent;
    const id = await sendVoiceReplyWithTextFallback({
      to: '+92',
      text: 'Please confirm',
      buttons,
      lang: 'english',
      tryVoice: async () => {
        throw new Error('gemini tts down');
      },
      sendText: async ({ to, text, buttons: b }) => {
        textSent = { to, text, buttons: b };
        return 'wamid.text.1';
      },
    });

    assert.equal(id, 'wamid.text.1');
    assert.deepEqual(textSent, { to: '+92', text: 'Please confirm', buttons });
  });

  it('still attempts TTS for an unsupported language and falls back on short audio', async () => {
    let tried = false;
    let textSent = false;
    const id = await sendVoiceReplyWithTextFallback({
      to: '+92',
      text: 'salam',
      lang: 'sindhi',
      unsupportedLanguages: 'punjabi,sindhi,balochi',
      tryVoice: async ({ guardShortAudio }) => {
        tried = true;
        assert.equal(guardShortAudio, true, 'uncertain language gets the short-audio guard');
        throw new Error('audio too short');
      },
      sendText: async () => {
        textSent = true;
        return 'wamid.text.2';
      },
    });

    assert.equal(tried, true, 'attempts TTS before falling back');
    assert.equal(textSent, true);
    assert.equal(id, 'wamid.text.2');
  });

  it('maps a roman variant to its plain base name for the fallback decision', async () => {
    let guard;
    await sendVoiceReplyWithTextFallback({
      to: '+92',
      text: 'salam',
      lang: 'roman-sindhi',
      unsupportedLanguages: 'punjabi,sindhi,balochi',
      tryVoice: async ({ guardShortAudio }) => {
        guard = guardShortAudio;
        return 'voice:1';
      },
    });
    assert.equal(guard, true, 'roman-sindhi matches the sindhi entry');
  });

  it('skips TTS entirely (text reply) for a `!`-prefixed language', async () => {
    let tried = false;
    let textSent;
    const id = await sendVoiceReplyWithTextFallback({
      to: '+92',
      text: 'salam',
      buttons: [{ id: 'x', title: 'X' }],
      lang: 'punjabi',
      unsupportedLanguages: '!punjabi,sindhi,balochi',
      tryVoice: async () => {
        tried = true;
        return 'voice:never';
      },
      sendText: async ({ to, text, buttons }) => {
        textSent = { to, text, buttons };
        return 'wamid.text.3';
      },
    });

    assert.equal(tried, false, 'text-only language never calls TTS');
    assert.equal(id, 'wamid.text.3');
    assert.deepEqual(textSent, { to: '+92', text: 'salam', buttons: [{ id: 'x', title: 'X' }] });
  });

  it('leaves supported languages unchanged (no short-audio guard)', async () => {
    let guard;
    await sendVoiceReplyWithTextFallback({
      to: '+92',
      text: 'salam',
      lang: 'pashto',
      tryVoice: async ({ guardShortAudio }) => {
        guard = guardShortAudio;
        return 'voice:1';
      },
    });
    assert.equal(guard, false, 'pashto keeps the original attempt-only behavior');
  });
});
