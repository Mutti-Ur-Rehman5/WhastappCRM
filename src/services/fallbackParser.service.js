import dayjs from 'dayjs';
import { todayInClinicTimeZone } from '../utils/datetime.util.js';












export const FALLBACK_UNREPLIED_HINT = 'Sorry, I did not understand. Please rephrase or type MENU.';
export const FALLBACK_MENU_REPLY =
  'I can help you book, cancel, reschedule or check an appointment.\nBook: "kal 5 baje appointment"\nCancel: "appointment cancel"\nReschedule: "appointment tabdeel"\nCheck: "mera appointment"';

export const FALLBACK_GREETING_REPLY =
  'Walaikum Assalam! Main aap ki kya madad kar sakta hoon? How can I help you today?';






export const FALLBACK_PHONE_REPROMPT =
  'Please enter a valid phone number (e.g. 0345 5555754). / Sahi phone number likhein (e.g. 0345 5555754).';

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function plusDays(todayRef, days) {
  return dayjs(`${todayRef}T00:00:00`).add(days, 'day').format('YYYY-MM-DD');
}

export function extractDate(text, todayRef) {
  const s = text.toLowerCase();

  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;



  m = /(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/.exec(s);
  if (m) {
    let dd = Number(m[1]);
    let mm = Number(m[2]);
    let yyyy = Number(m[3]);
    if (yyyy < 100) yyyy += 2000;
    if (mm > 12 && dd <= 12) [dd, mm] = [mm, dd];
    return `${String(yyyy).padStart(4, '0')}-${pad(mm)}-${pad(dd)}`;
  }


  m = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})/.exec(s);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3)];
    if (month) {
      const yearMatch = /(\d{4})/.exec(s);
      const year = yearMatch ? Number(yearMatch[1]) : Number(todayRef.slice(0, 4));
      return `${year}-${pad(month)}-${pad(Number(m[1]))}`;
    }
  }

  if (/\b(day after tomorrow|parson|paarson)\b/.test(s)) return plusDays(todayRef, 2);
  if (/\b(tomorrow|kal)\b/.test(s)) return plusDays(todayRef, 1);
  if (/\b(today|aaj|aj)\b/.test(s)) return todayRef;




  const DAY_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const dayMatch = /(?:^|\b)(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\b|$)/.exec(s);
  if (dayMatch) {
    const target = DAY_INDEX[dayMatch[1]];
    let diff = (target - dayjs(`${todayRef}T00:00:00`).day() + 7) % 7;
    if (diff === 0) diff = 7;
    return plusDays(todayRef, diff);
  }
  return null;
}

export function extractTime(text) {
  const s = text.toLowerCase();

  let m = /(\d{1,2}):(\d{2})\s*(am|pm)?/.exec(s);
  if (m) {
    let h = Number(m[1]);
    const minutes = Number(m[2]);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    if (h > 23 || minutes > 59) return null;
    return `${pad(h)}:${pad(minutes)}`;
  }

  m = /(\d{1,2})\s*(am|pm)\b/.exec(s);
  if (m) {
    let h = Number(m[1]);
    if (m[2] === 'pm' && h < 12) h += 12;
    if (m[2] === 'am' && h === 12) h = 0;
    if (h > 23) return null;
    return `${pad(h)}:00`;
  }





  const period = /\b(shaam)\b/.test(s)
    ? 18
    : /\b(raat|night)\b/.test(s)
      ? 21
      : /\b(dopehar)\b/.test(s)
        ? 13
        : /\b(subah|subha|morning)\b/.test(s)
          ? 9
          : null;
  const bajeMatch = /(\d{1,2})\s*(?:baje|bajy|bajay|o'?clock)\b/.exec(s);
  if (period === null) {
    if (bajeMatch) {
      let h = Number(bajeMatch[1]);
      if (h >= 1 && h <= 5) h += 12;
      if (h > 23) return null;
      return `${pad(h)}:00`;
    }
    return null;
  }

  m = bajeMatch;
  if (m) {
    let h = Number(m[1]);
    if (/\bshaam\b/.test(s) && h <= 12) h += 12;
    if (/\b(raat|night)\b/.test(s) && h <= 12) h += 12;
    if (/\bdopehar\b/.test(s) && h < 12) h += 12;
    if (h > 23) return null;
    return `${pad(h)}:00`;
  }
  return `${pad(period)}:00`;
}

export function parseConfirmation(text) {
  const lower = (text || '').trim().toLowerCase();
  if (!lower) return null;
  const raw = (text || '').trim();



  if (/^(yes|yeah|yep|yup|okay|ok|haan|han|haa?|ji|g|jee|hah|confirm|theek hai|theek ha|theek haan|theek hai ji|sahi|bilkul|done|chaleez|karo|pakka|zaroor|beshak|haanji|ok sir|ji bilkul|arey wa)\b/.test(lower)) return true;
  if (/^(no|nope|nahi|nahin|naheen|nai|nhi|nah|mat karo|theek nahi|theek nahin|sahi nahi|cancel mat|nahi chahiye|skip|nahi karo|mat karo|cancel|cancel kar|cancel karo|nahi karwane|nahi karni|nahi lagana|nahi chahta|rehne do|abhi nahi|leave it|never mind|no thanks|no thank you|nahi chaiye|nahi hota|bilkul nahi| bilkul nahin)\b/.test(lower)) return false;







  if (/^(جی\s*ہاں|ہاں|بالکل|ہو|باشی|بلیکل|هو|هیله ده|هاڻي|تي آهي|هيل آهي)/u.test(raw)) return true;
  if (/^(نہیں|نہیں\s*چاہیے|مت\s*کرو|منسوخ\s*کریں|نہیں\s*کروانا|نه\s*ږدل|نه|نه\s*چاھيي)/u.test(raw)) return false;
  return null;
}

export function parseFallback({ text, todayRef = todayInClinicTimeZone(), state }) {
  const raw = (text || '').trim();
  const lower = raw.toLowerCase();
  const date = extractDate(raw, todayRef);
  const time = extractTime(raw);

  if (!raw) return { name: 'smalltalk_or_unclear', input: { replyHint: FALLBACK_UNREPLIED_HINT } };

  if (/^menu$/.test(lower)) {
    return { name: 'smalltalk_or_unclear', input: { replyHint: FALLBACK_MENU_REPLY } };
  }













  const greeting = /^(aoa|assalam|asalam|aslam|salam|salaam|hello|hllo|hi|hey|slm|walekum|walaikum|good (morning|afternoon|evening)|subah (bakhair|bakhair)|salam o alaikum)\b/i.test(lower);




  const hasExplicitTime = /\b\d{1,2}\s*(?:baje|bajy|bajay|o'?clock)\b|\d{1,2}:\d{2}|\b\d{1,2}\s*(?:am|pm)\b/i.test(lower);
  const hasBookingSignal =
    Boolean(date) ||
    hasExplicitTime ||
    /\bcancel/.test(lower) ||
    /\b(reschedule|re-schedule|change (my )?(appointment|time|slot|date)|tabdeel)\b/.test(lower) ||
    /\b(available|free (slot|time)|khalil|khali|slots? on)\b/.test(lower) ||
    /\b(book|booking|karwa|karwana|karwani)\b/i.test(lower) ||
    /\b(new|nayi|naya|ek)\s+appointment\b/i.test(lower) ||
    (/\bappointment\b/i.test(lower) && /\b(milna|lena|leni|chahiye|banwana|chahata)\b/i.test(lower)) ||
    (/\b(doctor|doctora|doctr)\b/i.test(lower) && /\b(milna|book|dekhana|dikhana)\b/i.test(lower)) ||
    /\b(my )?appointment|kab hai|booked slot|status\b/.test(lower);
  if (greeting && !hasBookingSignal) {
    return { name: 'smalltalk_or_unclear', input: { replyHint: FALLBACK_GREETING_REPLY } };
  }







  if (state === 'COLLECTING_NAME' || state === 'COLLECTING_REASON') {
    return {
      name: 'book_appointment',
      input: state === 'COLLECTING_NAME' ? { name: raw } : { reason: raw },
    };
  }






  if (state === 'COLLECTING_PHONE') {
    const digits = raw.replace(/[^\d]/g, '');
    if (digits.length >= 10) {
      return { name: 'book_appointment', input: { phone: raw } };
    }
    if (digits.length > 0) {
      return { name: 'smalltalk_or_unclear', input: { replyHint: FALLBACK_PHONE_REPROMPT } };
    }
  }

  if (/\bcancel/.test(lower)) {
    return { name: 'cancel_appointment', input: {} };
  }
  if (/\b(reschedule|re-schedule|change (my )?(appointment|time|slot|date)|tabdeel)\b/.test(lower)) {
    return {
      name: 'reschedule_appointment',
      input: { ...(date ? { newDate: date } : {}), ...(time ? { newTime: time } : {}) },
    };
  }
  if (/\b(available|free (slot|time)|khalil|khali|slots? on)\b/.test(lower)) {
    return { name: 'check_availability', input: date ? { date } : {} };
  }



  if (date || time) {
    return {
      name: 'book_appointment',
      input: { ...(date ? { date } : {}), ...(time ? { time } : {}) },
    };
  }





  if (
    /\b(book|booking|karwa|karwana|karwani)\b/i.test(lower) ||
    /\b(new|nayi|naya|ek)\s+appointment\b/i.test(lower) ||
    (/\bappointment\b/i.test(lower) && /\b(milna|lena|leni|chahiye|banwana|chahata)\b/i.test(lower)) ||
    (/\b(doctor|doctora|doctr)\b/i.test(lower) && /\b(milna|book|dekhana|dikhana)\b/i.test(lower))
  ) {
    return {
      name: 'book_appointment',
      input: { ...(date ? { date } : {}), ...(time ? { time } : {}) },
    };
  }
  if (/\b(my )?appointment|kab hai|booked slot|status\b/.test(lower)) {
    return { name: 'query_my_appointments', input: {} };
  }
  return { name: 'smalltalk_or_unclear', input: { replyHint: FALLBACK_UNREPLIED_HINT } };
}
