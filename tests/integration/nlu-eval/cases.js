// Phase 3 NLU eval case catalog (DESIGN.md §3, RULES.md §9).
//
// This is the shared source of truth for the live eval runner
// (tests/integration/nlu-eval/run.js), the live-gated regression
// (tests/integration/nlu-eval/eval.test.js), and the mocked fast-CI safety
// suite (tests/unit/nlu.safety.test.js).
//
// Every case is evaluated against the INJECTED EVAL_TODAY_REF using the REAL
// Gemini pipeline. Expected dates are expressed as MARKERS (e.g. 'plus1',
// 'nextMonday') that the evaluator resolves from EVAL_TODAY_REF with dayjs —
// so a PASS always means "resolved exactly against the injected todayRef",
// never the model's own idea of the calendar date (RULES.md §9).
//
// Case spec:
//   intent         required primary tool name
//   acceptIntents  alternative tool names that are also acceptable
//   requires       fields that MUST be present, each { field, value | contains |
//                  containsAny | in:[markers/null] } (value/in resolve date/time
//                  markers via resolveDateMarker; contains* are case-insensitive
//                  substring checks for free-text name/reason)
//   requiresIfIntent  per-intent requires, keyed by tool name (for cases whose
//                  correct extraction differs by chosen intent)
//   absent         fields that MUST be absent — the model must never invent
//                  (inventing a date/time/name/reason the patient did not give
//                  is a FAIL even if every other field matches)
//   mustAskFollowUp  ambiguous case: when the model chose book_appointment the
//                  orchestrator slot-filler must produce a follow-up question
//                  (never AWAITING_CONFIRMATION). The evaluator runs the real
//                  handleBookIntent against the model's actual extraction.
//   note           human-readable expectation / ambiguity rationale for the report

export const EVAL_TODAY_REF = '2026-08-01'; // a Saturday — anchors relative dates deterministically

export const NLU_CASES = [
  // ── a. Clear English ────────────────────────────────────────────────
  {
    id: 'a1',
    category: 'a',
    label: 'Clear English, full request',
    input: 'I want to book an appointment tomorrow at 5pm for a fever checkup',
    intent: 'book_appointment',
    requires: [
      { field: 'date', value: 'plus1' },
      { field: 'time', value: '17:00' },
      { field: 'reason', containsAny: ['fever'] },
    ],
    absent: ['name', 'phone'],
  },

  // ── b. Pure Roman Urdu ──────────────────────────────────────────────
  {
    id: 'b1',
    category: 'b',
    label: 'Pure Roman Urdu, clear',
    input: 'mujhe kal shaam 5 baje appointment chahiye, bukhar ki wajah se',
    intent: 'book_appointment',
    requires: [
      { field: 'date', value: 'plus1' },
      { field: 'time', value: '17:00' },
      { field: 'reason', containsAny: ['bukhar', 'fever'] },
    ],
    absent: ['name', 'phone'],
  },

  // ── c. Mixed Roman Urdu + English (most realistic) ──────────────────
  {
    id: 'c1',
    category: 'c',
    label: 'Mixed Roman Urdu + English',
    input: 'yar mera appointment book kar do please, Monday ko 3 baje, throat me infection hai',
    intent: 'book_appointment',
    requires: [
      { field: 'date', value: 'nextMonday' },
      { field: 'time', value: '15:00' },
      { field: 'reason', containsAny: ['throat', 'infection', 'infec'] },
    ],
    absent: ['name', 'phone'],
  },

  // ── d. Fuzzy / relative time expressions ────────────────────────────
  {
    id: 'd1',
    category: 'd',
    label: 'kal (tomorrow)',
    input: 'kal appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'date', value: 'plus1' }],
    absent: ['time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'd2',
    category: 'd',
    label: 'parso (day after tomorrow)',
    input: 'parso appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'date', value: 'plus2' }],
    absent: ['time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'd3',
    category: 'd',
    label: 'next Monday',
    input: 'next Monday appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'date', value: 'nextMonday' }],
    absent: ['time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'd4',
    category: 'd',
    label: 'end of this week',
    input: 'is hafte ke akhir mein appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'date', in: ['endOfThisWeek', null] }],
    absent: ['time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
    note: 'End-of-week is inherently fuzzy — Sunday of this week, or a clarifying question, both pass. A weekday guess is a FAIL.',
  },
  {
    id: 'd5',
    category: 'd',
    label: 'shaam ko (evening, no hour)',
    input: 'shaam ko appointment chahiye',
    intent: 'book_appointment',
    requires: [],
    absent: ['date', 'time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
    note: '"shaam" without an hour must NOT be turned into a guessed 17:00 — ask which day and what time.',
  },
  {
    id: 'd6',
    category: 'd',
    label: 'subah subah (morning, no hour)',
    input: 'subah subah appointment chahiye',
    intent: 'book_appointment',
    requires: [],
    absent: ['date', 'time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'd7',
    category: 'd',
    label: 'afternoon (no hour)',
    input: 'dopeher ke baad appointment chahiye',
    intent: 'book_appointment',
    acceptIntents: ['check_availability'],
    requires: [],
    absent: ['date', 'time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
    note: 'No specific hour given — never invent one. Asking which day/time (or listing availability) is the safe behavior.',
  },
  {
    id: 'd8',
    category: 'd',
    label: 'in a little while',
    input: 'abhi thodi der baad appointment chahiye',
    intent: 'book_appointment',
    acceptIntents: ['smalltalk_or_unclear'],
    requires: [],
    absent: ['date', 'time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'd9',
    category: 'd',
    label: 'raat ko 9 baje (9 PM)',
    input: 'raat ko 9 baje appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'time', value: '21:00' }],
    absent: ['date', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },

  // ── e. Ambiguous / incomplete — must ASK, never guess ───────────────
  {
    id: 'e1',
    category: 'e',
    label: 'no date/time at all',
    input: 'appointment chahiye',
    intent: 'book_appointment',
    acceptIntents: ['smalltalk_or_unclear'],
    requires: [],
    absent: ['date', 'time', 'name', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'e2',
    category: 'e',
    label: 'tomorrow but no specific time',
    input: 'kal ka time chahiye',
    intent: 'book_appointment',
    acceptIntents: ['check_availability'],
    requires: [{ field: 'date', value: 'plus1' }],
    absent: ['time'],
    mustAskFollowUp: true,
    note: '"kal ka time" = tomorrow, exact time unknown. Either book-and-ask-time or list availability; it must NOT pick a time or read this as "my appointments".',
  },
  {
    id: 'e3',
    category: 'e',
    label: 'want to see the doctor (no details)',
    input: 'mujhe milna hai doctor se',
    intent: 'book_appointment',
    acceptIntents: ['smalltalk_or_unclear'],
    requires: [],
    absent: ['date', 'time', 'reason'],
    mustAskFollowUp: true,
  },

  // ── f. Reschedule intent variations ─────────────────────────────────
  {
    id: 'f1',
    category: 'f',
    label: 'move to Tuesday',
    input: 'mera appointment move kar do Tuesday pe',
    intent: 'reschedule_appointment',
    requires: [{ field: 'newDate', value: 'nextTuesday' }],
    absent: ['newTime', 'date', 'time'],
    note: 'Only the NEW date is given — the new time (and which appointment) still have to be collected.',
  },
  {
    id: 'f2',
    category: 'f',
    label: 'change the one I booked',
    input: 'wo jo maine book kiya tha wo change karna hai',
    intent: 'reschedule_appointment',
    requires: [],
    absent: ['newDate', 'newTime', 'date', 'time'],
    mustAskFollowUp: true,
    note: 'No target slot or new slot named — must ask which appointment and what new day/time.',
  },
  {
    id: 'f3',
    category: 'f',
    label: 'change the time',
    input: 'time badal do meri appointment ki',
    intent: 'reschedule_appointment',
    requires: [],
    absent: ['newDate', 'newTime'],
    mustAskFollowUp: true,
  },

  // ── g. Cancel intent variations ─────────────────────────────────────
  {
    id: 'g1',
    category: 'g',
    label: 'cancel kar do',
    input: 'cancel kar do mera appointment',
    intent: 'cancel_appointment',
    absent: ['date', 'time'],
  },
  {
    id: 'g2',
    category: 'g',
    label: "I won't come anymore",
    input: 'mujhe nahi aana ab',
    intent: 'cancel_appointment',
    absent: ['date', 'time'],
  },
  {
    id: 'g3',
    category: 'g',
    label: 'cancel that appointment please',
    input: 'wo appointment cancel kar dein please',
    intent: 'cancel_appointment',
    absent: ['date', 'time'],
  },

  // ── h. Query intent ─────────────────────────────────────────────────
  {
    id: 'h1',
    category: 'h',
    label: 'when is my appointment',
    input: 'mera appointment kab hai?',
    intent: 'query_my_appointments',
    absent: ['date', 'time', 'name', 'reason', 'phone'],
  },
  {
    id: 'h2',
    category: 'h',
    label: 'is my booking confirmed',
    input: 'meri booking confirm hui ya nahi?',
    intent: 'query_my_appointments',
    absent: ['date', 'time', 'name', 'reason', 'phone'],
  },
  {
    id: 'h3',
    category: 'h',
    label: 'what is my token number',
    input: 'token number kya hai mera?',
    intent: 'query_my_appointments',
    absent: ['date', 'time', 'name', 'reason', 'phone'],
  },

  // ── i. Multiple intents / topic switching ───────────────────────────
  {
    id: 'i1',
    category: 'i',
    label: 'check then maybe reschedule',
    input: 'pehle to batao mera appointment kab hai, aur agar time clash ho raha hai to reschedule kar dena Wednesday pe',
    intent: 'query_my_appointments',
    acceptIntents: ['reschedule_appointment'],
    requires: [],
    requiresIfIntent: {
      reschedule_appointment: [{ field: 'newDate', in: ['nextWednesday', null] }],
    },
    absent: ['date', 'time', 'name', 'reason', 'phone'],
    note: 'Two intents in one message; the contract is ONE tool call per turn. Query is the natural first choice; a reschedule (newDate=Wednesday) is acceptable too. Either must not invent anything.',
  },

  // ── j. Typos / informal spelling ────────────────────────────────────
  {
    id: 'j1',
    category: 'j',
    label: 'typo: apoint ment',
    input: 'mujhe ek apoint ment book karwani hai',
    intent: 'book_appointment',
    requires: [],
    absent: ['date', 'time', 'name', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'j2',
    category: 'j',
    label: 'typo: tumorow',
    input: 'tumorow appointment book karni hai',
    intent: 'book_appointment',
    requires: [{ field: 'date', value: 'plus1' }],
    absent: ['time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'j3',
    category: 'j',
    label: 'typo: wednessday',
    input: 'wednessday ko appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'date', value: 'nextWednesday' }],
    absent: ['time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'j4',
    category: 'j',
    label: 'typo: kaal (for kal)',
    input: 'kaal subah appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'date', value: 'plus1' }],
    absent: ['time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'j5',
    category: 'j',
    label: 'typo: chahye (for chahiye)',
    input: 'appointment chahye',
    intent: 'book_appointment',
    acceptIntents: ['smalltalk_or_unclear'],
    requires: [],
    absent: ['date', 'time', 'name', 'reason'],
    mustAskFollowUp: true,
  },

  // ── k. Numbers written differently ──────────────────────────────────
  {
    id: 'k1',
    category: 'k',
    label: '5 baje',
    input: '5 baje appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'time', value: '17:00' }],
    absent: ['date', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'k2',
    category: 'k',
    label: '5pm',
    input: '5pm appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'time', value: '17:00' }],
    absent: ['date', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'k3',
    category: 'k',
    label: '17:00',
    input: '17:00 par appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'time', value: '17:00' }],
    absent: ['date', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'k4',
    category: 'k',
    label: 'panch baje shaam (word number)',
    input: 'panch baje shaam ko appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'time', value: '17:00' }],
    absent: ['date', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },
  {
    id: 'k5',
    category: 'k',
    label: '5:00 PM',
    input: '5:00 PM appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'time', value: '17:00' }],
    absent: ['date', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
  },

  // ── l. Smalltalk / irrelevant — must NOT become a booking ───────────
  {
    id: 'l1',
    category: 'l',
    label: 'salaam',
    input: 'assalam o alaikum',
    intent: 'smalltalk_or_unclear',
    absent: ['date', 'time', 'name', 'phone', 'reason'],
  },
  {
    id: 'l2',
    category: 'l',
    label: 'how are you',
    input: 'aap kaisay hain',
    intent: 'smalltalk_or_unclear',
    absent: ['date', 'time', 'name', 'phone', 'reason'],
  },
  {
    id: 'l3',
    category: 'l',
    label: 'clinic address',
    input: 'clinic ka address kya hai',
    intent: 'smalltalk_or_unclear',
    absent: ['date', 'time', 'name', 'phone', 'reason'],
  },
  {
    id: 'l4',
    category: 'l',
    label: 'fees question',
    input: 'fees kitni hai',
    intent: 'smalltalk_or_unclear',
    absent: ['date', 'time', 'name', 'phone', 'reason'],
  },

  // ── m. Name + phone + reason all at once ────────────────────────────
  {
    id: 'm1',
    category: 'm',
    label: 'full details in one message',
    input: 'Ahmed Raza, 03001234567, appointment chahiye kal 4 baje, chest pain ki wajah se',
    intent: 'book_appointment',
    requires: [
      { field: 'date', value: 'plus1' },
      { field: 'time', value: '16:00' },
      { field: 'name', containsAny: ['Ahmed'] },
      { field: 'phone', value: '+923001234567' },
      { field: 'reason', containsAny: ['chest', 'pain'] },
    ],
    absent: [],
  },

  // ── n. Edge dates near month/year boundaries ────────────────────────
  {
    id: 'n1',
    category: 'n',
    label: '31 tareekh ko (the 31st)',
    input: '31 tareekh ko appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'date', in: ['thisMonth31', null] }],
    absent: ['time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
    note: 'With todayRef 2026-08-01 the next 31st is 2026-08-31. Accept that, or a clarifying question if the model is unsure — never a wrong day.',
  },
  {
    id: 'n2',
    category: 'n',
    label: 'end of this month',
    input: 'is mahine ke last mein appointment chahiye',
    intent: 'book_appointment',
    requires: [{ field: 'date', in: ['endOfThisMonth', null] }],
    absent: ['time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
    note: 'End-of-month is fuzzy — 2026-08-31 or a clarifying question both pass.',
  },
  {
    id: 'n3',
    category: 'n',
    label: 'January (month only, no day)',
    input: 'January mein appointment chahiye',
    intent: 'book_appointment',
    requires: [],
    absent: ['date', 'time', 'name', 'phone', 'reason'],
    mustAskFollowUp: true,
    note: 'CRITICAL no-guess case: "January" gives the month but NOT a day. Inventing date=2027-01-01 is a silent wrong guess and a FAIL — the bot must ask which day.',
  },
];

export const NLU_EVAL_CATEGORY_NAMES = {
  a: 'a. Clear English',
  b: 'b. Pure Roman Urdu',
  c: 'c. Mixed Roman Urdu + English',
  d: 'd. Fuzzy / relative time expressions',
  e: 'e. Ambiguous / incomplete (must ask)',
  f: 'f. Reschedule variations',
  g: 'g. Cancel variations',
  h: 'h. Query intent',
  i: 'i. Multiple intents / topic switch',
  j: 'j. Typos / informal spelling',
  k: 'k. Numbers written differently',
  l: 'l. Smalltalk (must not book)',
  m: 'm. Name + phone + reason at once',
  n: 'n. Edge dates (month/year boundaries)',
};
