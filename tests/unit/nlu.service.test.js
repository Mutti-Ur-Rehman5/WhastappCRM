import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import {
  createGeminiClient,
  extractToolCall,
  understandMessage,
  GEMINI_TOOLS,
  toGeminiFunctionDeclarations,
} from '../../src/services/nlu.service.js';
import { createCircuitBreaker } from '../../src/utils/circuitBreaker.util.js';
import { FALLBACK_UNREPLIED_HINT } from '../../src/services/fallbackParser.service.js';
import { NLU_PROMPT_VERSION, nluSystemPrompt } from '../../prompts/nlu.system.js';
import { TOOL_SCHEMA } from '../../src/orchestrator/tools.schema.js';

function mockGemini(behavior) {
  const calls = { models: [], requests: [], attempts: 0 };
  return {
    calls,
    getGenerativeModel(params) {
      calls.models.push(params);
      return {
        async generateContent(request) {
          calls.requests.push(request);
          calls.attempts += 1;
          // Real SDK shape: GenerateContentResult = { response, ... }.
          return { response: behavior(params, request, calls.attempts) };
        },
      };
    },
  };
}

const usage = { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 };
const functionCall = (name, args) => ({
  candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
  usageMetadata: usage,
});
const textOnly = (t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });

const HISTORY = [
  { role: 'user', text: 'kal shaam appointment chahiye' },
  { role: 'assistant', text: 'Zaroor! Kis waqt aur kis wajah se?' },
];

describe('extractToolCall', () => {
  it('extracts name + input from a functionCall part', () => {
    assert.deepEqual(extractToolCall(functionCall('book_appointment', { time: '17:00' })), {
      name: 'book_appointment',
      input: { time: '17:00' },
    });
  });

  it('defaults missing input to an empty object', () => {
    assert.deepEqual(extractToolCall(functionCall('confirm', null)), { name: 'confirm', input: {} });
  });

  it('maps a text-only response to smalltalk_or_unclear with the text as replyHint', () => {
    assert.deepEqual(extractToolCall(textOnly('hi there')), {
      name: 'smalltalk_or_unclear',
      input: { replyHint: 'hi there' },
    });
  });
});

describe('toGeminiFunctionDeclarations (DESIGN.md §3)', () => {
  it('maps the canonical TOOL_SCHEMA into Gemini function declarations', () => {
    assert.equal(GEMINI_TOOLS.length, 1, 'one tools entry wrapping the declarations');
    const declarations = GEMINI_TOOLS[0].functionDeclarations;
    assert.equal(declarations.length, TOOL_SCHEMA.length);
    assert.deepEqual(
      declarations.map((d) => d.name),
      TOOL_SCHEMA.map((t) => t.name),
    );
    assert.equal(declarations[0].name, 'book_appointment');
    assert.equal(declarations[0].parameters, TOOL_SCHEMA[0].input_schema, 'input_schema → parameters');
    assert.equal(declarations[0].parameters.type, 'object');
    assert.deepEqual(Object.keys(declarations[0].parameters.properties).sort(), [
      'date',
      'name',
      'phone',
      'reason',
      'time',
    ]);
    assert.equal(toGeminiFunctionDeclarations([TOOL_SCHEMA[0]])[0].name, 'book_appointment');
  });
});

describe('understandMessage', () => {
  it('transcribes a voice note first, then runs the text NLU on the transcript', async () => {
    const gemini = mockGemini((params) => {
      if (params.tools) return functionCall('book_appointment', { date: '2026-08-01', time: '17:00' });
      return textOnly('yar mujy appointment book karwani hai Friday ko');
    });

    const result = await understandMessage({
      phone: '+923001234567',
      history: [
        { role: 'user', text: 'kal shaam appointment chahiye' },
        { role: 'assistant', text: 'Zaroor! Kis waqt aur kis wajah se?' },
        { role: 'user', text: '[voice note]' },
      ],
      slots: {},
      todayRef: '2026-07-31',
      gemini,
      model: 'gemini-test-model',
      media: { mimeType: 'audio/ogg; codecs=opus', data: 'aGVsbG8=' },
    });

    assert.equal(gemini.calls.requests.length, 2, 'one transcription call + one NLU call');
    assert.equal(gemini.calls.models[0].tools, undefined, 'transcription is a TEXT-only call (no tools)');

    // First call: raw audio inline to produce the transcript.
    const transcribeRequest = gemini.calls.requests[0];
    assert.deepEqual(transcribeRequest.contents, [
      { role: 'user', parts: [{ inlineData: { mimeType: 'audio/ogg', data: 'aGVsbG8=' } }] },
    ]);

    // Second call: the transcript REPLACES the [voice note] marker; earlier
    // text turns stay intact so the model still has the conversation context.
    const nluRequest = gemini.calls.requests[1];
    assert.deepEqual(nluRequest.contents, [
      { role: 'user', parts: [{ text: 'kal shaam appointment chahiye' }] },
      { role: 'model', parts: [{ text: 'Zaroor! Kis waqt aur kis wajah se?' }] },
      { role: 'user', parts: [{ text: 'yar mujy appointment book karwani hai Friday ko' }] },
    ]);
    assert.deepEqual(result.toolCall, { name: 'book_appointment', input: { date: '2026-08-01', time: '17:00' } });
    assert.equal(result.transcript, 'yar mujy appointment book karwani hai Friday ko', 'the transcript is returned so the caller can store it in history');
  });

  it('falls back to the parser when the voice transcript is empty — the [voice note] marker never becomes a collected field', async () => {
    const gemini = mockGemini((params) => {
      if (params.tools) return functionCall('book_appointment', { date: '2026-08-01', time: '17:00' });
      return textOnly('   ');
    });

    const result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: '[voice note]' }],
      slots: {},
      todayRef: '2026-07-31',
      state: 'COLLECTING_NAME',
      gemini,
      model: 'gemini-test-model',
      media: { mimeType: 'audio/ogg', data: 'aGVsbG8=' },
    });

    assert.equal(result.source, 'fallback', 'a blank transcript must not reach the NLU call');
    assert.equal(gemini.calls.requests.length, 1, 'only the transcription call ran');
    assert.equal(result.toolCall.name, 'smalltalk_or_unclear', 'the literal marker must never be accepted as the collected name');
    assert.deepEqual(result.toolCall.input.replyHint, FALLBACK_UNREPLIED_HINT);
  });

  it('uses the transcript as the fallback text when transcription succeeded but the NLU call fails — a voice "yes" still confirms', async () => {
    const gemini = mockGemini((params) => {
      if (!params.tools) return textOnly('yes');
      throw new Error('gemini nlu call failed');
    });

    const result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: '[voice note]' }],
      slots: { date: '2026-08-01', time: '17:00' },
      todayRef: '2026-07-31',
      state: 'AWAITING_CONFIRMATION',
      gemini,
      model: 'gemini-test-model',
      media: { mimeType: 'audio/ogg', data: 'aGVsbG8=' },
    });

    assert.equal(result.source, 'classify+fallback');
    assert.deepEqual(result.toolCall, { name: 'confirm', input: { value: true } }, 'a voiced "yes" confirms even when the NLU call fails');
    assert.equal(result.transcript, 'yes');
  });

  it('builds the Gemini request: versioned system prompt + injected todayRef + slots + history', async () => {
    const gemini = mockGemini(() => functionCall('book_appointment', { date: '2026-08-01', time: '17:00' }));

    const result = await understandMessage({
      phone: '+923001234567',
      history: HISTORY,
      slots: { name: 'Ahmed' },
      todayRef: '2026-07-31',
      gemini,
      model: 'gemini-test-model',
    });

    const params = gemini.calls.models[0];
    assert.equal(params.model, 'gemini-test-model');
    assert.equal(
      params.toolConfig.functionCallingConfig.mode,
      'ANY',
      'model must reply only via function calls (one per turn)',
    );
    assert.deepEqual(params.tools, GEMINI_TOOLS);
    assert.equal(params.generationConfig.maxOutputTokens, 8192);

    // systemInstruction: [versioned prompt, todayRef+slots block]
    assert.equal(typeof params.systemInstruction, 'string');
    assert.ok(params.systemInstruction.includes(nluSystemPrompt), 'prompt teaches relative-date resolution');
    assert.ok(params.systemInstruction.includes('todayRef'), 'prompt teaches relative-date resolution');
    assert.ok(params.systemInstruction.includes('Roman Urdu'));
    assert.ok(params.systemInstruction.includes('todayRef=2026-07-31'));
    assert.ok(params.systemInstruction.includes('currentSlots={"name":"Ahmed"}'));
    assert.ok(params.systemInstruction.includes(NLU_PROMPT_VERSION));

    assert.deepEqual(params.gemini, undefined, 'no leftover provider-specific field on the model params');

    const request = gemini.calls.requests[0];
    assert.deepEqual(request.contents, [
      { role: 'user', parts: [{ text: 'kal shaam appointment chahiye' }] },
      { role: 'model', parts: [{ text: 'Zaroor! Kis waqt aur kis wajah se?' }] },
    ]);

    assert.deepEqual(result.toolCall, { name: 'book_appointment', input: { date: '2026-08-01', time: '17:00' } });
    assert.equal(result.usage, usage);
  });

  it('injects the patient language into every call so short replies do not switch languages', async () => {
    const gemini = mockGemini(() => functionCall('book_appointment', { date: '2026-08-01', time: '17:00' }));

    const result = await understandMessage({
      phone: '+923001234567',
      history: HISTORY,
      slots: {},
      todayRef: '2026-07-31',
      language: 'pashto',
      gemini,
      model: 'gemini-test-model',
    });

    const params = gemini.calls.models[0];
    assert.ok(params.systemInstruction.includes('patientLanguage=pashto'), 'patientLanguage is injected into the prompt');
    assert.ok(params.systemInstruction.includes(nluSystemPrompt), 'prompt still carries the versioned NLU rules');
    assert.ok(nluSystemPrompt.includes('LANGUAGE AND SCRIPT MATCHING'), 'prompt teaches script/language mirroring');
    assert.deepEqual(result.toolCall, { name: 'book_appointment', input: { date: '2026-08-01', time: '17:00' } });
  });

  it('retries once on a timeout/error, per DESIGN.md §10', async () => {
    const gemini = mockGemini(() => {
      if (gemini.calls.attempts < 2) throw new Error('connection timed out');
      return functionCall('smalltalk_or_unclear', { replyHint: 'salam!' });
    });

    const result = await understandMessage({
      phone: '+923001234567',
      history: HISTORY,
      slots: {},
      todayRef: '2026-07-31',
      gemini,
      model: 'gemini-test-model',
    });

    assert.equal(gemini.calls.attempts, 2, 'exactly one retry after the first failure');
    assert.equal(result.toolCall.name, 'smalltalk_or_unclear');
  });

  it('fails closed with a clear error when no API key is configured', () => {
    assert.throws(() => createGeminiClient(''), /GEMINI_API_KEY/);
  });

  it('uses the configured default model from env when none is passed', async () => {
    const gemini = mockGemini(() => functionCall('confirm', { value: true }));
    await understandMessage({
      phone: '+923001234567',
      history: [],
      slots: {},
      todayRef: '2026-07-31',
      gemini,
    });
    assert.equal(gemini.calls.models[0].model, env.geminiModel);
  });

  it('fails over to the rule-based parser when the circuit breaker is open (DESIGN.md §10)', async () => {
    const gemini = mockGemini(() => {
      throw new Error('API key not valid');
    });
    // Fast-threshold breaker so the test can trip it deterministically.
    const breaker = createCircuitBreaker(
      'gemini-test',
      async () => {
        throw new Error('upstream down');
      },
      { volumeThreshold: 2, errorThresholdPercentage: 99, resetTimeout: 1000, timeout: 1000 },
    );
    await assert.rejects(breaker.fire());
    await assert.rejects(breaker.fire());
    assert.equal(breaker.opened, true);

    const result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: 'book 2026-08-05 at 17:00' }],
      slots: {},
      todayRef: '2026-08-01',
      gemini,
      breaker,
    });

    assert.equal(result.source, 'fallback');
    assert.deepEqual(result.toolCall, {
      name: 'book_appointment',
      input: { date: '2026-08-05', time: '17:00' },
    });
    assert.equal(gemini.calls.requests.length, 0, 'open circuit: no Gemini request is made (fail fast)');
  });

  it('state-aware fallback: a bare "Yes" while AWAITING_CONFIRMATION maps to confirm (unsticks the patient)', async () => {
    const gemini = mockGemini(() => {
      throw new Error('API key not valid');
    });
    const breaker = createCircuitBreaker(
      'gemini-test',
      async () => {
        throw new Error('upstream down');
      },
      { volumeThreshold: 1, errorThresholdPercentage: 99, resetTimeout: 1000, timeout: 1000 },
    );
    await assert.rejects(breaker.fire());
    assert.equal(breaker.opened, true);

    const result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: 'Yes' }],
      slots: {},
      todayRef: '2026-08-01',
      state: 'AWAITING_CONFIRMATION',
      gemini,
      breaker,
    });

    assert.equal(result.source, 'fallback');
    assert.deepEqual(result.toolCall, { name: 'confirm', input: { value: true } });
  });

  it('state-aware fallback: "No" while AWAITING_CONFIRMATION maps to confirm(false)', async () => {
    const gemini = mockGemini(() => {
      throw new Error('API key not valid');
    });
    const breaker = createCircuitBreaker(
      'gemini-test',
      async () => {
        throw new Error('upstream down');
      },
      { volumeThreshold: 1, errorThresholdPercentage: 99, resetTimeout: 1000, timeout: 1000 },
    );
    await assert.rejects(breaker.fire());

    const result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: 'nahi' }],
      slots: {},
      todayRef: '2026-08-01',
      state: 'AWAITING_CONFIRMATION',
      gemini,
      breaker,
    });

    assert.deepEqual(result.toolCall, { name: 'confirm', input: { value: false } });
  });

  it('state-aware fallback: a non-confirmation text in AWAITING_CONFIRMATION still uses parseFallback (e.g. a fresh cancel request)', async () => {
    const gemini = mockGemini(() => {
      throw new Error('API key not valid');
    });
    const breaker = createCircuitBreaker(
      'gemini-test',
      async () => {
        throw new Error('upstream down');
      },
      { volumeThreshold: 1, errorThresholdPercentage: 99, resetTimeout: 1000, timeout: 1000 },
    );
    await assert.rejects(breaker.fire());

    const result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: 'appointment cancel karne ha' }],
      slots: {},
      todayRef: '2026-08-01',
      state: 'AWAITING_CONFIRMATION',
      gemini,
      breaker,
    });

    assert.equal(result.toolCall.name, 'cancel_appointment');
  });

  it('state-aware fallback is inert outside AWAITING_CONFIRMATION (a lone "yes" stays smalltalk)', async () => {
    const gemini = mockGemini(() => {
      throw new Error('API key not valid');
    });
    const breaker = createCircuitBreaker(
      'gemini-test',
      async () => {
        throw new Error('upstream down');
      },
      { volumeThreshold: 1, errorThresholdPercentage: 99, resetTimeout: 1000, timeout: 1000 },
    );
    await assert.rejects(breaker.fire());

    const result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: 'Yes' }],
      slots: {},
      todayRef: '2026-08-01',
      state: 'IDLE',
      gemini,
      breaker,
    });

    assert.equal(result.toolCall.name, 'smalltalk_or_unclear');
  });

  it('state-aware fallback: free text in COLLECTING_REASON is accepted as the reason (fixes the outage dead-end)', async () => {
    const gemini = mockGemini(() => {
      throw new Error('API key not valid');
    });
    const breaker = createCircuitBreaker(
      'gemini-test',
      async () => {
        throw new Error('upstream down');
      },
      { volumeThreshold: 1, errorThresholdPercentage: 99, resetTimeout: 1000, timeout: 1000 },
    );
    await assert.rejects(breaker.fire());

    const result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: 'Bukhar ha mujy' }],
      slots: { name: 'Mutti Ur Rehman' },
      todayRef: '2026-08-01',
      state: 'COLLECTING_REASON',
      gemini,
      breaker,
    });

    assert.equal(result.source, 'fallback');
    assert.deepEqual(result.toolCall, { name: 'book_appointment', input: { reason: 'Bukhar ha mujy' } });
  });

  it('routes a BLANK Gemini response (no function call, no text) to the fallback parser instead of empty smalltalk', async () => {
    // Thinking-model failure mode: output budget consumed by the thought token,
    // leaving only a thoughtSignature part — nothing extractToolCall can use.
    const gemini = mockGemini(() => ({
      candidates: [{ content: { parts: [{ thoughtSignature: 'th...' }] } }],
      usageMetadata: usage,
    }));

    const result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: 'book 2026-08-05 at 17:00' }],
      slots: {},
      todayRef: '2026-08-01',
      gemini,
      model: 'gemini-test-model',
    });

    assert.equal(result.source, 'fallback', 'blank Gemini output must not surface as an empty smalltalk reply');
    assert.deepEqual(result.toolCall, {
      name: 'book_appointment',
      input: { date: '2026-08-05', time: '17:00' },
    });
  });
});
