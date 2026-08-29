import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { Conversation } from '../../src/models/Conversation.model.js';
import {
  LANG,
  detectLanguage,
  pickLanguage,
  localized,
  doctorWith,
  genericDoctor,
  getConversationLanguage,
  confirmButtons,
  postBookButtons,
} from '../../src/services/localization.service.js';

const PHONE = '+923001234599';

before(async () => {
  await connectTestDb();
  await Conversation.deleteMany({ phone: { $regex: '^\\+9230012345' } });
});

after(async () => {
  await closeTestDb();
});

describe('detectLanguage', () => {
  it('detects Urdu script', () => {
    assert.equal(detectLanguage('میرا نام احمد ہے، کل صبح ملاقات چاہیے'), LANG.URDU);
  });

  it('detects Pashto script (distinctive Pashto letters)', () => {
    assert.equal(detectLanguage('زما نوم احمد دی، سبا غواړم راشم'), LANG.PASHTO);
  });

  it('detects Sindhi script (distinctive Sindhi letters)', () => {
    assert.equal(detectLanguage('مون کي ڊاڪٽر سان ملاقات گهرجي'), LANG.SINDHI);
  });

  it('detects Roman Urdu by keyword', () => {
    assert.equal(detectLanguage('kal shaam 5 baje appointment chahiye'), LANG.ROMAN_URDU);
  });

  it('detects Balochi in Arabic script via Balochi markers (no distinctive letters)', () => {
    assert.equal(detectLanguage('ہوب، من بک کنگ لوٹ'), LANG.BALOCHI);
    assert.equal(detectLanguage('شما کہ وہگت ملاقات چاهو؟'), LANG.BALOCHI);
    assert.equal(detectLanguage('من بلوچستان کان آئان'), LANG.BALOCHI);
  });

  it('detects Roman Balochi by keyword', () => {
    assert.equal(detectLanguage('hubb, mana yok appointment bokan'), LANG.ROMAN_BALOCHI);
  });

  it('treats plain English as english', () => {
    assert.equal(detectLanguage('Can you please tell me about the timings'), LANG.ENGLISH);
  });

  it('returns unknown for empty or pure-symbol input', () => {
    assert.equal(detectLanguage(''), LANG.UNKNOWN);
    assert.equal(detectLanguage('   '), LANG.UNKNOWN);
  });
});

describe('pickLanguage (short replies keep the previous language)', () => {
  it('keeps the previous language for ambiguous turns', () => {
    assert.equal(pickLanguage(LANG.UNKNOWN, LANG.PASHTO), LANG.PASHTO);
    assert.equal(pickLanguage(LANG.UNKNOWN, undefined), LANG.ROMAN_URDU);
  });

  it('switches when the patient clearly changes language', () => {
    assert.equal(pickLanguage(LANG.URDU, LANG.ROMAN_URDU), LANG.URDU);
  });
});

describe('localized (script templates)', () => {
  it('renders Urdu script and interpolates vars', () => {
    const text = localized('ask.name', LANG.URDU);
    assert.ok(text, 'urdu template exists');
    assert.match(text, /[\u0600-\u06FF]/);

    const confirm = localized('book.confirm', LANG.URDU, { date: '2026-08-20', time: '17:00', name: 'Ali', reason: 'fever' });
    assert.ok(confirm.includes('2026-08-20'));
    assert.ok(confirm.includes('Ali'));
  });

  it('returns null for non-script languages so callers keep bilingual defaults', () => {
    assert.equal(localized('ask.name', LANG.ROMAN_URDU), null);
    assert.equal(localized('ask.name', LANG.ENGLISH), null);
    assert.equal(localized('ask.name', LANG.UNKNOWN), null);
    assert.equal(localized('ask.name', undefined), null);
  });

  it('renders Pashto / Sindhi / Balochi where provided', () => {
    assert.match(localized('reminder', LANG.PASHTO, { tokenNo: 1, date: '2026-08-20', time: '17:00' }), /[\u0600-\u06FF]/);
    assert.match(localized('reminder', LANG.SINDHI, { tokenNo: 1, date: '2026-08-20', time: '17:00' }), /[\u0600-\u06FF]/);
    assert.ok(localized('reminder', LANG.BALOCHI, { tokenNo: 1, date: '2026-08-20', time: '17:00' }));
  });
});

describe('doctorWith / genericDoctor', () => {
  it('localizes the connector and falls back to " with "', () => {
    assert.equal(doctorWith('Dr X', LANG.URDU), ' کے ساتھDr X');
    assert.ok(doctorWith('Dr X', LANG.PASHTO).includes('سره'));
    assert.equal(doctorWith('Dr X', LANG.ROMAN_URDU), ' with Dr X');
    assert.equal(doctorWith(null, LANG.URDU), '');
  });

  it('localizes the generic doctor title', () => {
    assert.equal(genericDoctor(LANG.URDU), 'ڈاکٹر');
    assert.equal(genericDoctor(LANG.PASHTO), 'ډاکټر');
    assert.equal(genericDoctor(LANG.SINDHI), 'ڊاڪٽر');
    assert.equal(genericDoctor(LANG.ENGLISH), 'the doctor');
  });
});

describe('getConversationLanguage (async message paths)', () => {
  it('returns the stored conversation language, defaulting to roman-urdu', async () => {
    await Conversation.findOneAndUpdate({ phone: PHONE }, { $set: { language: LANG.PASHTO } }, { upsert: true });
    assert.equal(await getConversationLanguage(PHONE), LANG.PASHTO);

    await Conversation.deleteMany({ phone: PHONE });
    assert.equal(await getConversationLanguage(PHONE), LANG.ROMAN_URDU);
  });
});

describe('WhatsApp quick-reply buttons', () => {
  it('confirmButtons returns the spec ids with English titles by default', () => {
    assert.deepEqual(confirmButtons(undefined), [
      { id: 'confirm_booking_yes', title: '✅ Yes, confirm' },
      { id: 'confirm_booking_no', title: '✏️ No, change' },
    ]);
  });

  it('postBookButtons returns the spec ids with English titles by default', () => {
    assert.deepEqual(postBookButtons(undefined), [
      { id: 'appointment_cancel', title: '❌ Cancel' },
      { id: 'appointment_reschedule', title: '🔄 Reschedule' },
    ]);
  });

  it('localizes button titles for script-language patients', () => {
    const yes = confirmButtons(LANG.URDU).find((b) => b.id === 'confirm_booking_yes');
    assert.match(yes.title, /[\u0600-\u06FF]/, 'Urdu title uses Urdu script');
    const cancel = postBookButtons(LANG.PASHTO).find((b) => b.id === 'appointment_cancel');
    assert.match(cancel.title, /[\u0600-\u06FF]/, 'Pashto title uses Pashto script');
  });
});
