// LIVE end-to-end NLU check (RULES.md §7): sends ONE real request to Gemini
// and asserts a valid tool call comes back, proving the real API key, model,
// and function-calling format work together.
//
// Excluded from the default `npm test` glob (tests/integration/live/). Run it
// explicitly with the REAL .env loaded and the gate flag set:
//
//   $env:RUN_LIVE_TESTS='true'; node --env-file=.env --test "tests/integration/live/*.test.js"
//
// or, after setting the flag: npm run test:live
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { understandMessage } from '../../../src/services/nlu.service.js';
import { TOOL_SCHEMA } from '../../../src/orchestrator/tools.schema.js';

const runLive = process.env.RUN_LIVE_TESTS === 'true';
const VALID_TOOLS = TOOL_SCHEMA.map((t) => t.name);

test(
  'live Gemini: a sample booking message returns a valid book_appointment tool call',
  { skip: runLive ? false : 'set RUN_LIVE_TESTS=true and run with the real .env' },
  async () => {
    const todayRef = new Date().toISOString().slice(0, 10);
    const { toolCall, model, usage } = await understandMessage({
      phone: '+923035195001',
      history: [
        { role: 'user', text: 'I want to book an appointment tomorrow at 11am with Dr. Smith for a checkup' },
      ],
      slots: {},
      todayRef,
    });

    assert.ok(
      VALID_TOOLS.includes(toolCall.name),
      `toolCall.name '${toolCall.name}' is not a real tool — got ${JSON.stringify(toolCall.input)}`,
    );
    assert.equal(toolCall.name, 'book_appointment', `expected book_appointment, got ${toolCall.name}`);
    assert.ok(toolCall.input?.date, `expected a resolved date in the tool call input: ${JSON.stringify(toolCall.input)}`);
    assert.ok(toolCall.input?.time, `expected a resolved time in the tool call input: ${JSON.stringify(toolCall.input)}`);

    console.log(`Gemini OK — model=${model}, toolCall=${JSON.stringify(toolCall)}`);

    if (usage) console.log(`Gemini usage: ${JSON.stringify(usage)}`);
  },
);
