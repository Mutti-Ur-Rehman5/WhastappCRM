import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env.js';
import { TOOL_SCHEMA } from '../orchestrator/tools.schema.js';
import { nluSystemPrompt, NLU_PROMPT_VERSION } from '../../prompts/nlu.system.js';
import { withRetry } from '../utils/retry.util.js';
import { createCircuitBreaker } from '../utils/circuitBreaker.util.js';
import { normalizeAudioMimeType } from '../utils/media.util.js';
import { parseConfirmation, parseFallback } from './fallbackParser.service.js';
import { logger } from '../utils/logger.js';




const NLU_RETRY_ATTEMPTS = 2;






export const VOICE_NOTE_MARKER = '[voice note]';










const CONFIRM_CLASSIFY_PROMPT =
  'You are a simple yes/no classifier for a medical clinic chatbot. ' +
  'The patient was just asked to confirm or decline a pending appointment booking. ' +
  'Classify their reply as exactly one of these three words:\n' +
  '- AFFIRMATIVE: they are agreeing/confirming/approving, in ANY language, tone, script, or phrasing ' +
  '(e.g. yes, ok, haan, ji, g, theek hai, bilkul, done, achha, sahi, pakka, sure, why not, ' +
  'bariya, chaleez, haanji, jee bilkul, ok sir, are, inshallah, Allah willing, ' +
  'and any positive/affirmative response in ANY language or script including ' +
  'Urdu script (جی ہاں, ہاں, بالکل, ہو, باشی, بالیکل), ' +
  'Pashto script (هو, هیله ده, بالکل), ' +
  'Sindhi script (هاڻي, تي آهي, بالکل), etc.). ' +
  'Also classify as AFFIRMATIVE if the reply starts with a positive word even if it adds extra instructions ' +
  '(e.g. "ہاں، بک کر دو" = yes+book it, "ji karo" = yes+do it, "haan confirm" = yes+confirm).\n' +
  '- NEGATIVE: they are declining/refusing/saying no / cancelling / rejecting the offer, in ANY language, tone, script, or phrasing ' +
  '(e.g. no, nahi, nahin, na, nai, mat karo, cancel, cancel kar do, cancel karo, skip, ' +
  'not now, abhi nahi, rehne do, nahi chahiye, nahi karwane, nahi karni, theek nahi, ' +
  'nahi lagana, nahi chaiye, baad mein, phir kabhi, leave it, never mind, no thanks, ' +
  'no thank you, I do not want it, mujhe nahi karwana, mujhe nahi chahiye, ' +
  'Urdu script (نہیں, نہیں چاہیے, مت کرو, منسوخ کریں, نہیں کروانا), ' +
  'Pashto script (نه, نه ږدل), ' +
  'Sindhi script (نه, نه چاھيي, منسوخ ڪريو)).\n' +
  '- UNCLEAR: the reply does not clearly indicate yes or no — ' +
  'they asked an unrelated question, gave new information, or are ambiguous.\n' +
  'Reply with ONLY one word: AFFIRMATIVE, NEGATIVE, or UNCLEAR. Nothing else.';

export async function classifyConfirmation({
  text,
  language,
  phone,
  gemini = getGeminiClient(),
  model = env.geminiModel,
  breaker = getGeminiBreaker(),
}) {
  if (!text || !text.trim()) return null;

  const contents = [{ role: 'user', parts: [{ text: text.trim() }] }];
  const modelHandle = gemini.getGenerativeModel({
    model,
    systemInstruction: CONFIRM_CLASSIFY_PROMPT,
    generationConfig: { maxOutputTokens: 16, temperature: 0 },
  });

  try {
    const response = await breaker.fire({ modelHandle, contents, phone });
    const raw = (response?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text)
      .filter(Boolean)
      .join('')
      .trim()
      .toUpperCase();

    logger.debug('Confirmation classifier raw output', { phone, text: text.trim(), raw });

    if (raw.includes('AFFIRMATIVE')) {
      logger.info('Confirmation classified as AFFIRMATIVE', { phone, text: text.trim() });
      return 'AFFIRMATIVE';
    }
    if (raw.includes('NEGATIVE')) {
      logger.info('Confirmation classified as NEGATIVE', { phone, text: text.trim() });
      return 'NEGATIVE';
    }
    if (raw.includes('UNCLEAR')) {
      logger.info('Confirmation classified as UNCLEAR', { phone, text: text.trim() });
      return 'UNCLEAR';
    }

    logger.warn('Confirmation classifier returned unexpected output', { phone, raw });
    return 'UNCLEAR';
  } catch (err) {
    logger.warn('Confirmation classifier failed — falling back to keyword parser', { phone, err: err.message });
    return null;
  }
}





const FUNCTION_CALLING_ANY = { functionCallingConfig: { mode: 'ANY' } };







const GEMINI_MAX_OUTPUT_TOKENS = 8192;
















const TRANSCRIBE_PROMPT =
  'You are a verbatim speech-to-text transcriber. Transcribe the audio EXACTLY as spoken by the speaker. ' +
  'Write in the SAME script/language the speaker is using — do NOT translate, romanize, or convert between scripts. ' +
  'If the speaker is speaking Urdu in Urdu script (اردو), write in اردو script. ' +
  'If the speaker is speaking Pashto, write in Pashto. ' +
  'If the speaker is speaking Sindhi, write in Sindhi. ' +
  'If the speaker is speaking Balochi, write in Balochi. ' +
  'If the speaker is speaking English, write in English. ' +
  'If the speaker is speaking Roman Urdu (Urdu words in Latin/English letters), write in Roman Urdu. ' +
  'If the speaker mixes languages or scripts, mirror that mix exactly. ' +
  'Output ONLY the transcript — no commentary, no translation, no preamble, no quotation marks.';




export function toGeminiFunctionDeclarations(tools = TOOL_SCHEMA) {
  return tools.map(({ name, description, input_schema }) => ({
    name,
    description,
    parameters: input_schema,
  }));
}

export const GEMINI_TOOLS = [{ functionDeclarations: toGeminiFunctionDeclarations() }];

function fallbackDecision({ history, todayRef, state, textOverride, transcript }) {
  const currentTurn = [...(history || [])].reverse().find((turn) => turn.role !== 'assistant');
  const raw = textOverride ?? currentTurn?.text ?? '';
  const text = raw.trim() === VOICE_NOTE_MARKER ? '' : raw;


  logger.debug('fallback parser input', { state, raw, text });
  if (state === 'AWAITING_CONFIRMATION') {
    const value = parseConfirmation(text);
    if (value !== null) {
      return {
        toolCall: { name: 'confirm', input: { value } },
        usage: null,
        model: null,
        source: 'fallback',
        transcript,
      };
    }
  }
  return {
    toolCall: parseFallback({ text, todayRef, state }),
    usage: null,
    model: null,
    source: 'fallback',
    transcript,
  };
}




let geminiClient = null;

export function createGeminiClient(apiKey = env.geminiApiKey) {
  if (!apiKey) {
    throw new Error('Gemini API key not configured (GEMINI_API_KEY)');
  }
  return new GoogleGenerativeAI(apiKey);
}

function getGeminiClient() {
  if (!geminiClient) geminiClient = createGeminiClient();
  return geminiClient;
}








async function callGemini({ modelHandle, contents, phone }) {
  const result = await withRetry(
    () => modelHandle.generateContent({ contents }),
    {
      attempts: NLU_RETRY_ATTEMPTS,
      baseDelayMs: 200,
      shouldRetry: (err) => {

        if (err?.message?.includes('429') || err?.message?.includes('quota')) return false;
        return true;
      },
      context: { phone, service: 'gemini' },
    },
  );
  return result.response;
}

let geminiBreaker = null;

export function getGeminiBreaker() {
  if (!geminiBreaker) geminiBreaker = createCircuitBreaker('gemini', callGemini, {
    volumeThreshold: 3,
  });
  return geminiBreaker;
}


export function _resetGeminiBreaker() {
  geminiBreaker = null;
}

export function classifyInfraError(err) {
  const status = err?.response?.status;
  const msg = String(err?.message || '');
  const code = err?.code;

  if (status === 429 || msg.includes('429')) return 'quota';
  if (status >= 500) return 'server';
  if (code === 'ECONNABORTED' || msg.includes('timeout') || msg.includes('ETIMEDOUT')) return 'timeout';
  if (err?.name === 'CircuitBreakerOpenError' || msg.includes('circuit breaker')) return 'circuit_open';
  if (!err?.response && (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ENETUNREACH' || msg.includes('network'))) return 'network';
  return 'unknown';
}

export async function transcribeAudio({
  media,
  phone,
  gemini = getGeminiClient(),
  model = env.geminiModel,
  breaker = getGeminiBreaker(),
}) {
  const normalizedMime = normalizeAudioMimeType(media.mimeType);
  const audioBytesApprox = Math.round((media.data.length / 4) * 3);

  logger.debug('transcribeAudio: starting', {
    phone,
    model,
    declaredMimeType: media.mimeType,
    normalizedMime,
    audioBytesApprox,
  });

  const contents = [
    {
      role: 'user',
      parts: [{ inlineData: { mimeType: normalizedMime, data: media.data } }],
    },
  ];

  const modelHandle = gemini.getGenerativeModel({
    model,
    systemInstruction: TRANSCRIBE_PROMPT,
    generationConfig: { maxOutputTokens: 2048 },
  });

  let response;
  try {
    response = await breaker.fire({ modelHandle, contents, phone });
  } catch (err) {
    const errClass = classifyInfraError(err);
    logger.warn('transcribeAudio: Gemini call failed', { phone, err: err.message, errClass, model });
    throw err;
  }

  const parts = response?.candidates?.[0]?.content?.parts || [];
  const transcript = parts
    .map((part) => part.text)
    .filter(Boolean)
    .join(' ')
    .trim();

  logger.debug('transcribeAudio: Gemini response', {
    phone,
    model,
    transcriptLength: transcript.length,
    transcriptPreview: transcript.slice(0, 120),
    finishReason: response?.candidates?.[0]?.finishReason,
  });

  if (!transcript) {
    logger.warn('transcribeAudio: empty transcript', {
      phone,
      rawParts: parts,
      fullResponse: JSON.stringify(response).slice(0, 500),
    });
    throw new Error('Gemini returned an empty voice transcript');
  }

  logger.info('Voice note transcribed', { phone, model, chars: transcript.length });
  return transcript;
}

export function extractToolCall(response) {
  const candidates = response?.candidates || [];
  const parts = candidates[0]?.content?.parts || [];
  const fnPart = parts.find((part) => part.functionCall);
  if (fnPart?.functionCall) {
    return { name: fnPart.functionCall.name, input: fnPart.functionCall.args || {} };
  }
  const text = parts
    .map((part) => part.text)
    .filter(Boolean)
    .join(' ');
  return { name: 'smalltalk_or_unclear', input: { replyHint: text } };
}

export async function understandMessage({
  phone,
  history,
  slots,
  todayRef,
  state,
  gemini = getGeminiClient(),
  model = env.geminiModel,
  breaker = getGeminiBreaker(),
  media,
  language,
}) {
  let contents = (history || []).map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.text }],
  }));





  let transcript;
  if (media) {
    logger.debug('understandMessage: voice note detected, starting transcription', {
      phone,
      mimeType: media.mimeType,
      audioBytesApprox: Math.round((media.data.length / 4) * 3),
    });
    try {
      transcript = await transcribeAudio({ media, phone, gemini, model, breaker });
    } catch (err) {
      const errClass = classifyInfraError(err);
      logger.warn('Voice transcription infra error — voice unavailable fallback', {
        phone, errClass, errMessage: err.message,
      });
      const fallback = fallbackDecision({ history, todayRef, state });
      fallback.toolCall.voiceUnavailable = true;
      fallback.toolCall.voiceUnavailableReason = errClass;
      return fallback;
    }
    logger.debug('understandMessage: transcript obtained, replacing [voice note] marker', {
      phone,
      transcriptLength: transcript.length,
      transcriptPreview: transcript.slice(0, 120),
    });
    if (contents.length > 0) {
      contents[contents.length - 1] = { role: 'user', parts: [{ text: transcript }] };
    } else {
      contents.push({ role: 'user', parts: [{ text: transcript }] });
    }
  }







  if (state === 'AWAITING_CONFIRMATION') {
    const patientText = (transcript || history?.slice().reverse().find((t) => t.role !== 'assistant')?.text || '').trim();
    logger.debug('AWAITING_CONFIRMATION shortcut entered', { phone, patientTextPreview: patientText.slice(0, 120), state });
    if (patientText) {
      const verdict = await classifyConfirmation({ text: patientText, language, phone, gemini, model, breaker });
      if (verdict === 'AFFIRMATIVE') {
        return {
          toolCall: { name: 'confirm', input: { value: true } },
          usage: null,
          model,
          source: 'classify',
          transcript,
        };
      }
      if (verdict === 'NEGATIVE') {
        return {
          toolCall: { name: 'confirm', input: { value: false } },
          usage: null,
          model,
          source: 'classify',
          transcript,
        };
      }
      if (verdict === 'UNCLEAR') {



        const safetyValue = parseConfirmation(patientText);
        logger.debug('Confirmation UNCLEAR — safety net parseConfirmation', {
          phone, text: patientText, safetyValue,
        });
        if (safetyValue === true) {
          logger.debug('Confirmation classified as UNCLEAR but keyword parser says AFFIRMATIVE', { phone, text: patientText });
          return {
            toolCall: { name: 'confirm', input: { value: true } },
            usage: null, model, source: 'classify+fallback', transcript,
          };
        }
        if (safetyValue === false) {
          logger.debug('Confirmation classified as UNCLEAR but keyword parser says NEGATIVE — routing to confirm:false', { phone, text: patientText });
          return {
            toolCall: { name: 'confirm', input: { value: false } },
            usage: null, model, source: 'classify+fallback', transcript,
          };
        }
        logger.debug('Confirmation classified as UNCLEAR — re-asking', { phone, text: patientText });
        return {
          toolCall: { name: 'smalltalk_or_unclear', input: { replyHint: 'unclear_confirm' } },
          usage: null,
          model,
          source: 'classify',
          transcript,
        };
      }

      logger.debug('Confirmation classifier returned null (Gemini unavailable) — falling through to fallback parser', { phone });
    }




    const fallbackText = (transcript || history?.slice().reverse().find((t) => t.role !== 'assistant')?.text || '').trim();
    if (fallbackText) {
      const fallbackValue = parseConfirmation(fallbackText);
      logger.debug('Fallback parser confirmation check', { phone, text: fallbackText, fallbackValue });
      if (fallbackValue !== null) {
        logger.debug('Confirmation classified via fallback parser', { phone, text: fallbackText, value: fallbackValue });
        return {
          toolCall: { name: 'confirm', input: { value: fallbackValue } },
          usage: null,
          model: null,
          source: 'fallback',
          transcript,
        };
      }
      logger.debug('Fallback parser returned null — falling through to full NLU', { phone, text: fallbackText });
    } else {
      logger.debug('AWAITING_CONFIRMATION: no patient text found — falling through to full NLU', { phone });
    }
  }

  const systemInstruction = [
    nluSystemPrompt,




    `todayRef=${todayRef}\ncurrentSlots=${JSON.stringify(slots || {})}\npatientLanguage=${language || 'unknown'}\n(promptVersion=${NLU_PROMPT_VERSION})`,
  ].join('\n\n');

  const modelParams = {
    model,
    systemInstruction,
    tools: GEMINI_TOOLS,
    toolConfig: FUNCTION_CALLING_ANY,
    generationConfig: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
  };




  const loggableContents = (contents || []).map((turn) => ({
    role: turn.role,
    parts: turn.parts.map((part) =>
      part.inlineData
        ? { inlineData: { mimeType: part.inlineData.mimeType, data: `<${Math.round((part.inlineData.data.length / 4) * 3)} bytes>` } }
        : part,
    ),
  }));
  logger.debug('NLU request', { phone, model, todayRef, promptVersion: NLU_PROMPT_VERSION, contents: loggableContents });


  const lastUserText = (contents || []).filter(c => c.role === 'user').pop()?.parts?.[0]?.text || '';
  logger.info('NLU raw user text', {
    phone,
    textPreview: lastUserText.slice(0, 200),
    charCodes: [...lastUserText.slice(0, 20)].map(c => c.codePointAt(0)),
    hasLatin: /[A-Za-z]/.test(lastUserText),
    hasArabicScript: /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(lastUserText),
    state,
  });

  const modelHandle = gemini.getGenerativeModel(modelParams);

  let response;
  try {
    response = await breaker.fire({ modelHandle, contents, phone });
  } catch (err) {





    const errClass = classifyInfraError(err);
    logger.warn('Gemini unavailable — fallback parser engaged', {
      phone,
      err: err.message,
      errClass,
      breaker: breaker.name || 'gemini',
    });
    const fallback = fallbackDecision({ history, todayRef, state, textOverride: transcript, transcript });



    if (fallback.toolCall.name === 'smalltalk_or_unclear' && media) {
      fallback.toolCall.voiceUnavailable = true;
      fallback.toolCall.voiceUnavailableReason = errClass;
    }
    return fallback;
  }

  const toolCall = extractToolCall(response);

  logger.info('NLU decision point', {
    phone,
    hasTranscript: Boolean(transcript),
    toolCallName: toolCall.name,
    replyHint: (toolCall.input?.replyHint || '').slice(0, 100),
    source: 'gemini',
  });

  if (toolCall.name === 'smalltalk_or_unclear' && !(toolCall.input?.replyHint || '').trim()) {





    logger.warn('Gemini blank response — fallback parser engaged', {
      phone,
      rawParts: response?.candidates?.[0]?.content?.parts,
    });
    return fallbackDecision({ history, todayRef, state, textOverride: transcript, transcript });
  }






  if (transcript && toolCall.name === 'smalltalk_or_unclear') {
    const fallbackResult = parseFallback({ text: transcript, todayRef, state });
    if (fallbackResult.name !== 'smalltalk_or_unclear') {
      logger.debug('Voice transcript rescued by fallback parser', {
        phone,
        transcript,
        fallbackIntent: fallbackResult.name,
      });
      return { toolCall: fallbackResult, usage: response.usageMetadata, model, source: 'gemini+fallback', transcript };
    }
  }

  logger.info('NLU response', {
    phone,
    model,
    toolCallName: toolCall.name,
    replyHint: (toolCall.input?.replyHint || '').slice(0, 120),
    source: 'gemini',
    hasTranscript: Boolean(transcript),
    usage: response.usageMetadata,
  });

  return { toolCall, usage: response.usageMetadata, model, source: 'gemini', transcript };
}
