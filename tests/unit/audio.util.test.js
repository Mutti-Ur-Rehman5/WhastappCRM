import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ffmpegStatic from 'ffmpeg-static';
import {
  parsePcmFormat,
  buildWavHeader,
  wrapPcmInWav,
  transcodeToWhatsAppAudio,
  WHATSAPP_VOICE_MIME_TYPE,
} from '../../src/utils/audio.util.js';

const hasFfmpeg = Boolean(ffmpegStatic);

describe('WHATSAPP_VOICE_MIME_TYPE', () => {
  it('is the OGG/OPUS mime WhatsApp accepts for voice notes', () => {
    assert.equal(WHATSAPP_VOICE_MIME_TYPE, 'audio/ogg; codecs=opus');
  });
});

describe('parsePcmFormat', () => {
  it('parses rate and channels from the Gemini L16 mime', () => {
    assert.deepEqual(parsePcmFormat('audio/L16;rate=24000;channels=1'), { sampleRate: 24000, channels: 1, sampleWidth: 2 });
    assert.deepEqual(parsePcmFormat('audio/L16;rate=44100;channels=2'), { sampleRate: 44100, channels: 2, sampleWidth: 2 });
  });

  it('defaults to 24kHz mono when the mime carries no parameters', () => {
    assert.deepEqual(parsePcmFormat('audio/L16'), { sampleRate: 24000, channels: 1, sampleWidth: 2 });
    assert.deepEqual(parsePcmFormat(''), { sampleRate: 24000, channels: 1, sampleWidth: 2 });
    assert.deepEqual(parsePcmFormat(undefined), { sampleRate: 24000, channels: 1, sampleWidth: 2 });
  });
});

describe('wrapPcmInWav', () => {
  it('writes a well-formed RIFF/WAVE header describing the PCM', () => {
    const pcm = Buffer.alloc(8, 0);
    const wav = wrapPcmInWav(pcm, { sampleRate: 24000, channels: 1, sampleWidth: 2 });

    assert.equal(wav.length, 44 + 8);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(40), 8, 'data chunk length');
    assert.equal(wav.readUInt32LE(24), 24000, 'sample rate');
    assert.equal(wav.readUInt16LE(22), 1, 'channels');
    assert.equal(wav.readUInt16LE(34), 16, 'bits per sample');
    assert.equal(wav.subarray(44).equals(pcm), true, 'PCM bytes are preserved verbatim');
  });

  it('buildWavHeader keeps RIFF size accounting consistent', () => {
    const header = buildWavHeader({ sampleRate: 24000, channels: 1, sampleWidth: 2, byteLength: 100 });
    assert.equal(header.length, 44);
    assert.equal(header.readUInt32LE(4), 36 + 100, 'RIFF chunk size = 36 + data');
  });
});

describe('transcodeToWhatsAppAudio', () => {
  it('produces an OggS/OPUS buffer from PCM when ffmpeg is available', { skip: !hasFfmpeg && 'ffmpeg-static binary missing' }, async () => {
    const pcm = Buffer.alloc(24000 * 2, 0);
    const ogg = await transcodeToWhatsAppAudio({ pcm, sourceMimeType: 'audio/L16;rate=24000;channels=1' });

    assert.ok(ogg.length > 0, 'produced audio bytes');
    assert.equal(ogg.subarray(0, 4).toString(), 'OggS', 'OGG container magic');
  });

  it('rejects when the configured ffmpeg binary cannot run', async () => {
    await assert.rejects(
      () => transcodeToWhatsAppAudio({ pcm: Buffer.alloc(2), ffmpegPath: 'no-such-ffmpeg-binary-on-path' }),
    );
  });
});
