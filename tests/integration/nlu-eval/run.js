// Phase 3 NLU eval runner — REAL Gemini, no mocks.
//
//   node --env-file=.env tests/integration/nlu-eval/run.js
//   node --env-file=.env tests/integration/nlu-eval/run.js --only=d,j
//   node --env-file=.env tests/integration/nlu-eval/run.js --only=a1,c1,m1
//
// Sends every case in cases.js through the real nlu.service.understandMessage
// (live GEMINI_API_KEY from .env), evaluates intent + entity extraction against
// the injected todayRef, checks the orchestrator follow-up safety property, and
// writes the review report to tests/integration/nlu-eval/results.md.
//
// RATE LIMITS: the eval must respect the provider's per-minute quota (this key
// is free tier: ~5 requests/min/model). Requests are paced to a global
// EVAL_RPM (default 4) so we never trip a 429; cases that STILL end up in the
// rule-based fallback (transient 429/network hiccup) get ONE quiet re-run at
// the end, serially, before being scored. The report records source=gemini vs
// source=fallback per case so fallback "passes" are visible, not hidden.
//
// The eval deliberately uses a widened Gemini breaker (120s) instead of the
// production 15s so we measure the model's TRUE accuracy; the report's
// "production-latency risk" line counts cases that would have tripped the
// production budget into the rule-based fallback.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { understandMessage } from '../../../src/services/nlu.service.js';
import { NLU_PROMPT_VERSION } from '../../../prompts/nlu.system.js';
import { env } from '../../../src/config/env.js';
import { closeRedis } from '../../../src/config/redis.js';
import { closeInboundQueue } from '../../../src/queues/inboundMessage.queue.js';
import { closeSheetsQueues } from '../../../src/queues/sheetsSync.queue.js';
import { closeNotifyDoctorQueues } from '../../../src/queues/notifyDoctor.queue.js';
import { closeNotifyPatientQueue } from '../../../src/queues/notifyPatient.queue.js';
import { closeRemindersQueues } from '../../../src/queues/reminders.queue.js';
import {
  createEvalGeminiBreaker,
  evaluateCase,
  safetyCheckFollowUp,
  describeExpected,
  buildMarkdownReport,
} from './eval.js';
import { NLU_CASES, EVAL_TODAY_REF, NLU_EVAL_CATEGORY_NAMES } from './cases.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(HERE, 'results.md');
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 1);
const RPM = Number(process.env.EVAL_RPM || 4); // requests per minute (free tier ~5)
const MIN_START_GAP_MS = 60_000 / RPM;

async function shutdown() {
  try {
    await closeInboundQueue();
    await closeSheetsQueues();
    await closeNotifyDoctorQueues();
    await closeNotifyPatientQueue();
    await closeRemindersQueues();
    await closeRedis();
  } catch (err) {
    console.error('cleanup warning:', err.message);
  }
}

function parseOnly(argv) {
  const flag = argv.find((a) => a.startsWith('--only='));
  if (!flag) return null;
  return new Set(flag.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean));
}

class Pacer {
  constructor(gapMs) {
    this.gapMs = gapMs;
    this.nextAt = 0;
  }
  async wait() {
    const now = Date.now();
    const delay = Math.max(0, this.nextAt - now);
    if (delay > 0) await sleep(delay);
    this.nextAt = Date.now() + this.gapMs;
  }
}

async function runCase(c, breaker, pacer) {
  await pacer.wait();
  const start = process.hrtime.bigint();
  let result;
  try {
    result = await understandMessage({
      phone: '+923001234567',
      history: [{ role: 'user', text: c.input }],
      slots: {},
      todayRef: EVAL_TODAY_REF,
      breaker,
    });
  } catch (err) {
    result = { toolCall: { name: 'smalltalk_or_unclear', input: { error: err.message } }, source: 'error' };
  }
  const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
  const toolCall = result.toolCall || { name: 'smalltalk_or_unclear', input: {} };
  const evaluation = evaluateCase(c, toolCall, { todayRef: EVAL_TODAY_REF });
  const safety = await safetyCheckFollowUp(c, toolCall);
  return {
    case: c,
    actual: toolCall,
    expected: describeExpected(c, { todayRef: EVAL_TODAY_REF }),
    source: result.source,
    latencyMs: Math.round(latencyMs),
    ...evaluation,
    safety,
  };
}

async function runPool(cases, breaker, pacer, concurrency) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < cases.length) {
      const i = next;
      next += 1;
      const c = cases[i];
      try {
        results[i] = await runCase(c, breaker, pacer);
      } catch (err) {
        results[i] = {
          case: c,
          actual: { name: 'ERROR', input: { error: err.message } },
          expected: describeExpected(c, { todayRef: EVAL_TODAY_REF }),
          source: 'error',
          latencyMs: -1,
          pass: false,
          failures: [`runner error: ${err.message}`],
          checks: ['runner crashed before evaluation'],
          intentOk: false,
          safety: { ok: false, detail: 'runner crashed before safety check' },
        };
      }
      process.stdout.write('.');
    }
  }
  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}

function score(results) {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const fallback = results.filter((r) => r.source === 'fallback').length;
  const riskCases = results.filter((r) => r.latencyMs > 15_000).length;
  return { passed, failed, fallback, riskCases };
}

async function main() {
  const only = parseOnly(process.argv.slice(2));
  let cases = NLU_CASES;
  if (only) {
    cases = NLU_CASES.filter((c) => only.has(c.category) || only.has(c.id));
    if (cases.length === 0) {
      console.error(`--only matched nothing. Filter by category letters (a..n) or case ids (${NLU_CASES.map((c) => c.id).join(',')})`);
      process.exit(2);
    }
  }

  const breaker = createEvalGeminiBreaker();
  const pacer = new Pacer(MIN_START_GAP_MS);

  console.log(`Running ${cases.length} case(s) (concurrency ${CONCURRENCY}, paced to ${RPM}/min, todayRef ${EVAL_TODAY_REF})...`);
  let results = await runPool(cases, breaker, pacer, CONCURRENCY);

  // One quiet re-run pass for cases that hit the fallback (transient 429 /
  // network blip) so a hiccup is not scored as a model failure.
  const toRetry = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.source === 'fallback' || r.source === 'error');
  if (toRetry.length > 0) {
    console.log(`\n${toRetry.length} case(s) hit the fallback — re-running serially after a 35s cooldown...`);
    await sleep(35_000);
    const serialPacer = new Pacer(MIN_START_GAP_MS);
    for (const { r, i } of toRetry) {
      process.stdout.write(`retry[${r.case.id}]`);
      try {
        results[i] = await runCase(r.case, breaker, serialPacer);
      } catch {
        // keep the original (failed) result
      }
    }
    console.log('');
  }

  const { passed, failed, fallback, riskCases } = score(results);

  const report = buildMarkdownReport({
    todayRef: EVAL_TODAY_REF,
    results,
    promptVersion: NLU_PROMPT_VERSION,
    model: env.geminiModel,
    passed,
    failed,
    riskCases,
    fallbackRemaining: fallback,
  });
  writeFileSync(RESULTS_PATH, report, 'utf8');

  console.log('\n');
  console.log(`Model: ${env.geminiModel} | prompt v${NLU_PROMPT_VERSION} | todayRef ${EVAL_TODAY_REF}`);
  console.log(`${passed}/${results.length} pass, ${failed} fail, ${fallback} scored via fallback parser, ${riskCases} over the 15s production budget`);
  console.log(`Report written to ${RESULTS_PATH}`);

  const failedCases = results.filter((r) => !r.pass);
  if (failedCases.length > 0) {
    console.log('FAILED:');
    for (const r of failedCases) {
      console.log(`  [${r.case.id}] (${r.source}) ${r.case.input}`);
      console.log(`    → ${r.actual.name} ${JSON.stringify(r.actual.input)}`);
      console.log(`    → ${r.failures.join(' | ')}`);
    }
  } else {
    console.log('All cases passed.');
  }
  return failedCases.length > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await shutdown();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('Eval crashed:', err);
    await shutdown();
    process.exit(2);
  });
