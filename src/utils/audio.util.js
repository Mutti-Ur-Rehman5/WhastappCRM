import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { env } from '../config/env.js';

const execFileAsync = promisify(execFile);



export const WHATSAPP_VOICE_MIME_TYPE = 'audio/ogg; codecs=opus';


const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_SAMPLE_WIDTH = 2;

export function parsePcmFormat(mimeType = '') {
  const params = {};
  for (const part of mimeType.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    const num = Number(raw);
    params[key] = Number.isFinite(num) ? num : raw;
  }
  return {
    sampleRate: typeof params.rate === 'number' ? params.rate : DEFAULT_SAMPLE_RATE,
    channels: typeof params.channels === 'number' ? params.channels : DEFAULT_CHANNELS,
    sampleWidth: DEFAULT_SAMPLE_WIDTH,
  };
}

export function buildWavHeader({ sampleRate, channels, sampleWidth, byteLength }) {
  const blockAlign = channels * sampleWidth;
  const byteRate = sampleRate * blockAlign;
  const bitsPerSample = sampleWidth * 8;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(byteLength, 40);
  return header;
}

export function wrapPcmInWav(pcm, fmt = {}) {
  const { sampleRate = DEFAULT_SAMPLE_RATE, channels = DEFAULT_CHANNELS, sampleWidth = DEFAULT_SAMPLE_WIDTH } = fmt;
  const header = buildWavHeader({ sampleRate, channels, sampleWidth, byteLength: pcm.length });
  return Buffer.concat([header, pcm]);
}

export async function transcodeToWhatsAppAudio({ pcm, sourceMimeType = 'audio/L16;rate=24000', ffmpegPath, maxBuffer = 50 * 1024 * 1024 }) {
  const binaryPath = ffmpegPath || env.ffmpegPath || ffmpegStatic;
  if (!binaryPath) {
    throw new Error('No ffmpeg binary available for audio conversion (set FFMPEG_PATH)');
  }

  const pcmBytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const wav = wrapPcmInWav(pcmBytes, parsePcmFormat(sourceMimeType));

  const inPath = join(tmpdir(), `tts-${randomUUID()}.wav`);
  const outPath = join(tmpdir(), `tts-${randomUUID()}.ogg`);
  try {
    await writeFile(inPath, wav);
    await execFileAsync(binaryPath, [
      '-y',
      '-loglevel', 'error',
      '-i', inPath,
      '-c:a', 'libopus',
      '-b:a', '24k',
      '-ar', '24000',
      '-ac', '1',
      '-f', 'ogg',
      outPath,
    ], { maxBuffer });
    return await readFile(outPath);
  } finally {
    for (const path of [inPath, outPath]) {
      try { await unlink(path); } catch {  }
    }
  }
}
