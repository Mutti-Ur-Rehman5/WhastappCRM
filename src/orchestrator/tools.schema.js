// Canonical tool schema (DESIGN.md §3). Kept in a dedicated module so the
// schema is reusable by the API wrapper (src/services/nlu.service.js) and
// testable independently of any LLM SDK call. The NLU service maps it into the
// active provider's format at call time (Gemini uses `parameters` instead of
// the legacy `input_schema` spelling).

export const TOOL_SCHEMA = [
  {
    name: 'book_appointment',
    description: 'Patient wants to book a new appointment (in ANY script: English, Roman Urdu, Urdu script اردو, Pashto پښتو, Sindhi سندي, etc.)',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date YYYY-MM-DD, resolved from relative terms like kal/tomorrow against todayRef' },
        time: { type: 'string', description: 'HH:mm 24h, resolved from fuzzy terms like shaam/subah' },
        reason: { type: 'string', description: 'Reason for the visit (English or Roman Urdu, as given)' },
        name: { type: 'string', description: "Patient's full name" },
        phone: { type: 'string', description: 'Patient phone in E.164 (+92...) form' },
      },
    },
  },
  {
    name: 'reschedule_appointment',
    description: 'Patient wants to move an existing appointment to a different date/time (works in ALL languages: English, Roman Urdu, Urdu/Pashto/Sindhi script)',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date of the EXISTING appointment, or null if unknown' },
        time: { type: 'string', description: 'Time of the EXISTING appointment, or null if unknown' },
        newDate: { type: 'string', description: 'ISO date YYYY-MM-DD the patient wants instead (resolved from relative terms against todayRef)' },
        newTime: { type: 'string', description: 'HH:mm 24h the patient wants instead' },
      },
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Patient wants to cancel an existing appointment (works in ALL languages: English, Roman Urdu, Urdu/Pashto/Sindhi script)',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date of the appointment to cancel' },
        time: { type: 'string', description: 'HH:mm of the appointment to cancel' },
        latest: { type: 'boolean', description: 'true when the patient wants their most recent upcoming appointment cancelled without a date' },
      },
    },
  },
  {
    name: 'check_availability',
    description: 'Patient asks which times/slots are free on a day (works in ALL languages: English, Roman Urdu, Urdu/Pashto/Sindhi script)',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date YYYY-MM-DD to check, resolved from relative terms against todayRef' },
        time: { type: 'string', description: 'Optional HH:mm hint' },
      },
    },
  },
  {
    name: 'query_my_appointments',
    description: "Patient asks about their own appointments (e.g. 'mera appointment kab hai?' or 'میرا اپائنٹمنٹ کب ہے؟' or 'زما اپائنمنټ کله دی؟' or 'مونھنجو اپائنمنٽ ڪڏھڙو آهي؟')",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'confirm',
    description: 'Patient answers YES or NO to a confirmation question. Works in ALL scripts and languages: English (yes/no), Roman Urdu (haan/nahi/ji/ok), Urdu script (جی ہاں/ہاں/نہیں/بالکل), Pashto script (هو/نه), Sindhi script (هاڻي/نه/تي آهي), etc.',
    input_schema: {
      type: 'object',
      properties: {
        value: { type: 'boolean', description: 'true = yes/confirm, false = no/cancel the attempt' },
      },
    },
  },
  {
    name: 'smalltalk_or_unclear',
    description: 'Greetings, thanks, off-topic, or any message that does not clearly match another intent (works in ALL languages and scripts)',
    input_schema: {
      type: 'object',
      properties: {
        replyHint: { type: 'string', description: 'Short friendly bilingual (English + Roman Urdu) reply to send to the patient' },
      },
    },
  },
];
