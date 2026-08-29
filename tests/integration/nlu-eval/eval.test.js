// Live-gated Phase 3 NLU regression — the full a–n eval set against REAL
// Gemini, run once per invocation and asserted twice:
//   1. every case meets its expected intent + entity interpretation, and
//   2. the "no wrong guess" safety property holds for every ambiguous case
//      (the real slot-filler asks a follow-up, never a silent confirmation).
//
// Excluded from the default `npm test` glob (tests/integration/*.test.js).
// Run it with the REAL .env and the gate flag:
//
//   $env:RUN_LIVE_TESTS='true'; node --env-file=.env --test "tests/integration/nlu-eval/*.test.js"
//
// (npm script: `npm run test:nlu-eval` after setting RUN_LIVE_TESTS=true.)
//
// Because todayRef is the fixed EVAL_TODAY_REF (2026-08-01), every run is
// deterministic and comparable across runs — relative-date correctness is
// verified against the injected todayRef, never the model's calendar.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { understandMessage } from '../../../src/services/nlu.service.js';
import {
  createEvalGeminiBreaker,
  evaluateCase,
  safetyCheckFollowUp,
  describeExpected,
} from './eval.js';
import { NLU_CASES, EVAL_TODAY_REF, NLU_EVAL_CATEGORY_NAMES } from './cases.js';

const runLive = process.env.RUN_LIVE_TESTS === 'true';
const SKIP = 'set RUN_LIVE_TESTS=true and run with the real .env (node --env-file=.env ...)';

let results = [];

before({ timeout: 15 * 60_000 }, async () => {
  if (!runLive) return;
  const breaker = createEvalGeminiBreaker();
  for (const c of NLU_CASES) {
    const result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: c.input }],
      slots: {},
      todayRef: EVAL_TODAY_REF,
      breaker,
    });
    const toolCall = result.toolCall || { name: 'smalltalk_or_unclear', input: {} };
    const evaluation = evaluateCase(c, toolCall, { todayRef: EVAL_TODAY_REF });
    const safety = await safetyCheckFollowUp(c, toolCall);
    results.push({ case: c, toolCall, evaluation, safety, source: result.source });
  }
});

function failureDetail(r) {
  return [
    `[${r.case.id}] "${r.case.input}"`,
    `  expected: ${describeExpected(r.case, { todayRef: EVAL_TODAY_REF })}`,
    `  actual:   ${r.toolCall.name} ${JSON.stringify(r.toolCall.input)}`,
    `  source:   ${r.source}`,
    `  extraction failures: ${r.evaluation.failures.join(' | ') || 'none'}`,
    `  safety:   ${r.safety.detail}`,
  ].join('\n');
}

test(
  'live NLU eval: intent + entity extraction across all categories a–n',
  { skip: runLive ? false : SKIP, timeout: 15 * 60_000 },
  () => {
    const failed = results.filter((r) => !r.evaluation.pass);
    assert.deepEqual(
      failed.map(failureDetail),
      [],
      `${failed.length} case(s) did not meet the expected interpretation:\n${failed.map(failureDetail).join('\n')}`,
    );
  },
);

test(
  'live NLU eval: no-wrong-guess safety — ambiguous cases ask a follow-up, never a silent confirmation',
  { skip: runLive ? false : SKIP, timeout: 15 * 60_000 },
  () => {
    const ambiguous = results.filter((r) => r.case.mustAskFollowUp);
    const unsafe = ambiguous.filter((r) => !r.safety.ok);
    assert.deepEqual(
      unsafe.map(failureDetail),
      [],
      `${unsafe.length} ambiguous case(s) reached a confirmation without every field being patient-supplied:\n${unsafe.map(failureDetail).join('\n')}`,
    );
  },
);

test(
  'live NLU eval: report summary line',
  { skip: runLive ? false : SKIP },
  () => {
    const passed = results.filter((r) => r.evaluation.pass).length;
    console.log(
      `NLU eval: ${passed}/${results.length} pass (${NLU_CASES.length} cases across ${Object.keys(NLU_EVAL_CATEGORY_NAMES).length} categories, todayRef ${EVAL_TODAY_REF})`,
    );
  },
);
