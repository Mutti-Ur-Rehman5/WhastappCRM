// Shared evaluation logic for the Phase 3 NLU eval (DESIGN.md §3, RULES.md §9).
//
// resolveDateMarker resolves a case's expected-date MARKER (e.g. 'plus1',
// 'nextMonday') against the injected EVAL_TODAY_REF using dayjs — the same
// timezone-agnostic "server-injected todayRef is authoritative" contract the
// production prompt follows. A PASS therefore means the model produced exactly
// the date the server would compute from todayRef; the model is never trusted
// to know the calendar date.
//
// The safety check drives the model's ACTUAL extraction through the real
// orchestrator slot-filler (handleBookIntent) so an ambiguous message can be
// proven to end in a follow-up question rather than a confirmation summary.

import dayjs from 'dayjs';
import { createCircuitBreaker } from '../../../src/utils/circuitBreaker.util.js';
import { handleBookIntent } from '../../../src/orchestrator/intents/book.intent.js';
import { EVAL_TODAY_REF } from './cases.js';

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const NEXT_WEEKDAY_RE = /^next(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;

const DATE_MARKERS = new Set([
  'today',
  'plus0',
  'plus1',
  'plus2',
  'endOfThisWeek',
  'endOfThisMonth',
  'thisMonth31',
  ...Object.keys(WEEKDAY_INDEX).map((d) => `next${d[0].toUpperCase()}${d.slice(1)}`),
]);

function plusDays(todayRef, days) {
  return dayjs(`${todayRef}T00:00:00`).add(days, 'day').format('YYYY-MM-DD');
}

/** Resolves an expected-date marker against the injected todayRef. */
export function resolveDateMarker(marker, todayRef = EVAL_TODAY_REF) {
  if (marker === 'today' || marker === 'plus0') return todayRef;
  if (marker === 'plus1') return plusDays(todayRef, 1);
  if (marker === 'plus2') return plusDays(todayRef, 2);

  const m = NEXT_WEEKDAY_RE.exec(marker);
  if (m) {
    const target = WEEKDAY_INDEX[m[1].toLowerCase()];
    let d = dayjs(`${todayRef}T00:00:00`);
    for (let i = 1; i <= 8; i += 1) {
      d = d.add(1, 'day');
      if (d.day() === target) return d.format('YYYY-MM-DD');
    }
  }

  if (marker === 'endOfThisWeek') {
    // Sunday of the Mon–Sun week containing todayRef.
    const d = dayjs(`${todayRef}T00:00:00`);
    return plusDays(todayRef, (7 - d.day()) % 7);
  }

  if (marker === 'endOfThisMonth') {
    return dayjs(`${todayRef}T00:00:00`).endOf('month').format('YYYY-MM-DD');
  }

  if (marker === 'thisMonth31') {
    let cursor = dayjs(`${todayRef}T00:00:00`);
    for (let monthOffset = 0; monthOffset < 24; monthOffset += 1) {
      const last = cursor.endOf('month');
      if (last.date() >= 31) {
        const candidate = cursor.date(31);
        if (candidate.format('YYYY-MM-DD') >= todayRef) return candidate.format('YYYY-MM-DD');
      }
      cursor = cursor.add(1, 'month');
    }
  }
  return null;
}

/** Human-readable expected date derivation for the report. */
export function describeDate(marker, todayRef = EVAL_TODAY_REF) {
  const resolved = resolveDateMarker(marker, todayRef);
  return `${resolved} (${marker} of todayRef ${todayRef})`;
}

function isDateLike(marker) {
  return DATE_MARKERS.has(marker);
}

/**
 * Breaker used by the eval (NOT the production one): the production 15s
 * per-call budget is deliberately widened here so we measure the model's TRUE
 * NLU accuracy, and separately flag how often production's 15s budget would
 * have diverted a call to the rule-based fallback (see run.js's latency
 * column / results.md risk summary).
 */
export function createEvalGeminiBreaker() {
  return createCircuitBreaker(
    'nlu-eval',
    async ({ modelHandle, contents }) => modelHandle.generateContent({ contents }),
    {
      timeout: 120_000,
      resetTimeout: 60_000,
      volumeThreshold: 50,
      errorThresholdPercentage: 99,
      rollingCountTimeout: 60_000,
      enableSnapshots: false,
    },
  );
}

const REQUIRED_FIELDS = ['date', 'time', 'name', 'reason', 'phone'];

/** Matches a single requirement ({field, value|contains|containsAny|in}) against actual input. */
function matchRequirement(req, actual, todayRef) {
  const actualValue = actual[req.field];
  const present = actualValue !== undefined && actualValue !== null && actualValue !== '';

  if (req.in !== undefined) {
    const acceptable = req.in.map((v) => (v === null ? null : resolveDateMarker(v, todayRef)));
    if (!present) {
      return acceptable.includes(null)
        ? { ok: true, actual: '(absent)', expected: `one of ${acceptable.map((v) => v ?? '(absent)').join(', ')}` }
        : { ok: false, actual: '(absent)', expected: `one of ${acceptable.filter((v) => v !== null).join(', ')}` };
    }
    return acceptable.includes(actualValue)
      ? { ok: true, actual: actualValue, expected: acceptable.filter((v) => v !== null).join(' or ') }
      : { ok: false, actual: actualValue, expected: acceptable.filter((v) => v !== null).join(' or ') };
  }

  if (req.containsAny) {
    if (!present) return { ok: false, actual: '(absent)', expected: `contains any of ${req.containsAny.join(', ')}` };
    const ok = req.containsAny.some((sub) => String(actualValue).toLowerCase().includes(sub.toLowerCase()));
    return { ok, actual: actualValue, expected: `contains any of ${req.containsAny.join(', ')}` };
  }

  if (req.contains) {
    if (!present) return { ok: false, actual: '(absent)', expected: `contains ${req.contains}` };
    const ok = String(actualValue).toLowerCase().includes(String(req.contains).toLowerCase());
    return { ok, actual: actualValue, expected: `contains ${req.contains}` };
  }

  // value: a date/time/phone literal or a date marker
  const expectedValue = isDateLike(req.value) ? resolveDateMarker(req.value, todayRef) : req.value;
  if (!present) return { ok: false, actual: '(absent)', expected: expectedValue };
  return { ok: actualValue === expectedValue, actual: actualValue, expected: expectedValue };
}

/**
 * Evaluates one case against the model's actual tool call.
 * @param {Object} c case definition (tests/integration/nlu-eval/cases.js)
 * @param {{name: string, input: Object}} actual
 * @param {Object} [opts] {todayRef}
 * @returns {{pass: boolean, failures: string[], checks: string[], intentOk: boolean}}
 */
export function evaluateCase(c, actual, { todayRef = EVAL_TODAY_REF } = {}) {
  const failures = [];
  const checks = [];
  const allowedIntents = [c.intent, ...(c.acceptIntents || [])];
  const intentOk = allowedIntents.includes(actual.name);
  checks.push(`intent ${actual.name} ${intentOk ? '∈' : '∉'} allowed {${allowedIntents.join(', ')}}`);
  if (!intentOk) failures.push(`intent: expected one of ${allowedIntents.join(', ')}, got ${actual.name}`);

  const requires = [...(c.requires || []), ...((c.requiresIfIntent && c.requiresIfIntent[actual.name]) || [])];
  for (const req of requires) {
    const r = matchRequirement(req, actual.input, todayRef);
    checks.push(`${req.field}: actual=${r.actual} expected=${r.expected} ${r.ok ? '✓' : '✗'}`);
    if (!r.ok) failures.push(`field ${req.field}: expected ${r.expected}, got ${r.actual}`);
  }

  for (const field of c.absent || []) {
    const present = actual.input[field] !== undefined && actual.input[field] !== null && actual.input[field] !== '';
    checks.push(`${field}: ${present ? `PRESENT(${actual.input[field]}) ✗ must be absent` : 'absent ✓'}`);
    if (present) failures.push(`invented ${field}: model output ${JSON.stringify(actual.input[field])} for a field the patient never gave`);
  }

  return { pass: failures.length === 0, failures, checks, intentOk };
}

/**
 * Orchestrator-level safety check (RULES.md §2, requirement 5): for AMBIGUOUS
 * (mustAskFollowUp) cases the model's actual book_appointment extraction is fed
 * through the real slot-filler. Passing means the bot ASKS for the still-missing
 * fields and does NOT present an AWAITING_CONFIRMATION summary with a guessed
 * slot. Non-book tool choices trivially satisfy this (no silent booking).
 *
 * Non-ambiguous cases are governed by the requires/absent field checks instead —
 * a complete case like m1 reaching AWAITING_CONFIRMATION is CORRECT, not a
 * failure.
 */
export async function safetyCheckFollowUp(c, actual) {
  if (!c.mustAskFollowUp) {
    return { ok: true, detail: 'non-ambiguous — completeness governed by requires/absent checks' };
  }
  if (actual.name !== 'book_appointment') {
    return {
      ok: true,
      detail: `intent ${actual.name} — no booking can be silently created`,
    };
  }
  const conv = { phone: '+923001234567', slots: { phone: '+923001234567' } };
  const result = handleBookIntent({ conv, input: actual.input });
  const asksFollowUp = result.nextState !== 'AWAITING_CONFIRMATION' && result.missing.length > 0;
  return {
    ok: asksFollowUp,
    detail: asksFollowUp
      ? `slot-filler asks for missing: ${result.missing.join(', ')} (→ ${result.nextState})`
      : `slot-filler reached AWAITING_CONFIRMATION with a complete guessed slot set: ${JSON.stringify(result.slots)}`,
  };
}

/**
 * Human-readable "what we expected" line for the report table.
 */
export function describeExpected(c, { todayRef = EVAL_TODAY_REF } = {}) {
  const parts = [`intent=${c.intent}`];
  for (const req of c.requires || []) {
    if (req.in !== undefined) {
      const list = req.in.map((v) => (v === null ? 'absent' : describeDate(v, todayRef))).join(' | ');
      parts.push(`${req.field}∈{${list}}`);
    } else if (req.containsAny) {
      parts.push(`${req.field}∋[${req.containsAny.join('|')}]`);
    } else if (req.contains) {
      parts.push(`${req.field}∋"${req.contains}"`);
    } else if (isDateLike(req.value)) {
      parts.push(`${req.field}=${describeDate(req.value, todayRef)}`);
    } else {
      parts.push(`${req.field}="${req.value}"`);
    }
  }
  if (c.absent && c.absent.length) parts.push(`no ${c.absent.join(', ')} invented`);
  return parts.join('; ');
}

/** Truncates a long input for the report table. */
export function shortText(text, max = 46) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Builds the full markdown report. */
export function buildMarkdownReport({
  todayRef,
  results,
  promptVersion,
  model,
  passed,
  failed,
  riskCases,
  fallbackRemaining = 0,
}) {
  const lines = [];
  lines.push('# Phase 3 NLU eval report (live Gemini)');
  lines.push('');
  lines.push(`- **Model**: \`${model}\``);
  lines.push(`- **Prompt version**: \`${promptVersion}\``);
  lines.push(`- **Injected todayRef**: \`${todayRef}\` (a Saturday — every relative date in this report is resolved against THIS injected date, never the model's own calendar)`);
  lines.push(`- **Cases**: ${results.length} total — **${passed} pass**, **${failed} fail**`);
  lines.push(`- **Scored via rule-based fallback** (Gemini unavailable after re-run): ${fallbackRemaining}`);
  lines.push(`- **Production-latency risk**: ${riskCases} of ${results.length} cases took >15s (the production per-call breaker budget) and would have been diverted to the rule-based fallback instead of real NLU`);
  lines.push('');
  lines.push('## Legend');
  lines.push('');
  lines.push('- Expected dates are shown as the resolved literal PLUS the marker/todayRef derivation, e.g. `2026-08-02 (plus1 of todayRef 2026-08-01)`.');
  lines.push('- `(absent)` in the Actual column = the model correctly did not invent that field.');
  lines.push('- A red `INVENTED` failure means the model fabricated a field the patient never provided — the worst failure class.');
  lines.push('- `must-ask` cases (categories d/e/f/g/n) MUST produce a follow-up question; the table shows the slot-filler result.');
  lines.push('- `source=fallback` means the rule-based parser answered (Gemini 429/timeout) — such results are re-run once before scoring.');
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| ID | Category | Input | Expected | Actual tool call | Follow-up check | Pass |');
  lines.push('|----|----------|-------|----------|------------------|-----------------|------|');
  for (const r of results) {
    const expected = r.expected;
    const actual = `\`${r.actual.name}\` ${JSON.stringify(r.actual.input)}`;
    lines.push(
      `| ${r.case.id} | ${r.case.category} | \`${shortText(r.case.input)}\` | ${expected} | ${actual} | ${r.safety.detail} | ${r.pass ? '✅' : '❌'} |`,
    );
  }
  lines.push('');
  lines.push('## Failures');
  lines.push('');
  const failedCases = results.filter((r) => !r.pass);
  if (failedCases.length === 0) {
    lines.push('None — every case met its expected interpretation. 🎉');
  } else {
    for (const r of failedCases) {
      lines.push(`### ${r.case.id} — ${r.case.category} — "${r.case.input}"`);
      lines.push('');
      lines.push(`**source**: ${r.source} (${r.latencyMs}ms)${r.source === 'fallback' ? ' — Gemini was unavailable, the rule-based fallback answered' : ''}`);
      lines.push('');
      lines.push('**Expected**: ' + r.expected);
      lines.push('');
      lines.push(`**Actual**: \`${r.actual.name}\` ${JSON.stringify(r.actual.input)}`);
      lines.push('');
      lines.push('**Checks**:');
      lines.push('');
      for (const ch of r.checks) lines.push(`- ${ch}`);
      lines.push('');
      lines.push('**Failures**:');
      lines.push('');
      for (const f of r.failures) lines.push(`- ${f}`);
      lines.push('');
      if (r.case.note) {
        lines.push(`**Ambiguity note**: ${r.case.note}`);
        lines.push('');
      }
    }
  }
  lines.push('## Category summary');
  lines.push('');
  lines.push('| Category | Pass | Total |');
  lines.push('|----------|------|-------|');
  const byCat = new Map();
  for (const r of results) {
    if (!byCat.has(r.case.category)) byCat.set(r.case.category, { pass: 0, total: 0 });
    byCat.get(r.case.category).total += 1;
    if (r.pass) byCat.get(r.case.category).pass += 1;
  }
  for (const [cat, v] of byCat) {
    lines.push(`| ${cat} | ${v.pass} | ${v.total} |`);
  }
  lines.push('');
  lines.push('_Generated by `node --env-file=.env tests/integration/nlu-eval/run.js`. Do not edit by hand._');
  lines.push('');
  return lines.join('\n');
}
