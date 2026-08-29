import { Conversation } from '../models/Conversation.model.js';























export const LANG = {
  URDU: 'urdu',
  ROMAN_URDU: 'roman-urdu',
  SINDHI: 'sindhi',
  ROMAN_SINDHI: 'roman-sindhi',
  PASHTO: 'pashto',
  ROMAN_PASHTO: 'roman-pashto',
  BALOCHI: 'balochi',
  ROMAN_BALOCHI: 'roman-balochi',
  ENGLISH: 'english',
  UNKNOWN: 'unknown',
};




const SCRIPT_LANGS = [LANG.URDU, LANG.SINDHI, LANG.PASHTO, LANG.BALOCHI];






const ARABIC_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const PASHTO_LETTERS_RE = /[\u0693\u0696\u069A\u06BC\u06AB\u0689\u0681\u0685]/;
const SINDHI_LETTERS_RE = /[\u0684\u0687\u068A\u068C\u068D\u068F\u0673\u06BB\u067D\u067A]/;
const BALOCHI_LETTERS_RE = /[\u06CF]/;
const BALOCHI_ARABIC_KEYWORDS = /(هوب|ھوب|ہوب|شما|پیندا|بلوچ|بلوچی|بلوچستان)/;

const ROMAN_URDU_KEYWORDS =
  /\b(kal|aaj|aj|baje|bajy|bajay|shaam|subah|subha|raat|dopehar|mujy|mujhe|nahi|nai|nhi|haan|han|karni|karna|karwana|karwani|chahiye|hai|hain|aapka|aapki|mera|meri|kis|kya|kaunsa|doctor|appointment|book|theek|wajah|wala|wale|karo|karein|acha|thek|zyada|nahin|apni|aana)\b/i;

const ROMAN_PASHTO_KEYWORDS = /\b(zma|khpal|ratlo|wr(o|u)okh|mara|ratalo|maloom|pa ke|che se)\b/i;
const ROMAN_SINDHI_KEYWORDS = /\b(tawhanjo|tawhanji|aahin|khe|sain|je|manhoon|socho|banno)\b/i;
const ROMAN_BALOCHI_KEYWORDS = /\b(mana|tho|shuma|hubb|mum|dama|baz|peida)\b/i;

export function detectLanguage(text) {
  const raw = (text || '').trim();
  if (!raw) return LANG.UNKNOWN;

  if (ARABIC_SCRIPT_RE.test(raw)) {
    if (PASHTO_LETTERS_RE.test(raw)) return LANG.PASHTO;
    if (SINDHI_LETTERS_RE.test(raw)) return LANG.SINDHI;
    if (BALOCHI_LETTERS_RE.test(raw) || BALOCHI_ARABIC_KEYWORDS.test(raw)) return LANG.BALOCHI;
    return LANG.URDU;
  }

  if (/[A-Za-z]/.test(raw)) {
    if (ROMAN_PASHTO_KEYWORDS.test(raw)) return LANG.ROMAN_PASHTO;
    if (ROMAN_SINDHI_KEYWORDS.test(raw)) return LANG.ROMAN_SINDHI;
    if (ROMAN_BALOCHI_KEYWORDS.test(raw)) return LANG.ROMAN_BALOCHI;
    if (ROMAN_URDU_KEYWORDS.test(raw)) return LANG.ROMAN_URDU;
    return LANG.ENGLISH;
  }

  return LANG.UNKNOWN;
}

export function pickLanguage(detected, previous) {
  if (detected === LANG.UNKNOWN) return previous || LANG.ROMAN_URDU;
  return detected;
}

function interpolate(text, vars = {}) {
  return text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : `{${k}}`));
}


const LANG_KEY = {
  [LANG.URDU]: 'ur',
  [LANG.SINDHI]: 'sd',
  [LANG.PASHTO]: 'ps',
  [LANG.BALOCHI]: 'bl',
  [LANG.ROMAN_URDU]: 'ru',
  [LANG.ENGLISH]: 'en',
};

export function localized(id, lang, vars = {}) {
  if (!lang || !SCRIPT_LANGS.includes(lang)) return null;
  const entry = MESSAGES[id];
  const text = entry?.[LANG_KEY[lang]];
  if (!text) return null;
  return interpolate(text, vars);
}


export function doctorWith(doctorName, lang) {
  if (!doctorName) return '';
  const connector = {
    [LANG.URDU]: ' کے ساتھ',
    [LANG.SINDHI]: ' سان',
    [LANG.PASHTO]: ' سره',
    [LANG.BALOCHI]: ' ساتا',
  }[lang] || ' with ';
  return connector + doctorName;
}




export function confirmButtons(lang) {
  return [
    { id: 'confirm_booking_yes', title: localized('btn.confirmYes', lang) ?? '✅ Yes, confirm' },
    { id: 'confirm_booking_no', title: localized('btn.confirmNo', lang) ?? '✏️ No, change' },
  ];
}

export function postBookButtons(lang) {
  return [
    { id: 'appointment_cancel', title: localized('btn.cancel', lang) ?? '❌ Cancel' },
    { id: 'appointment_reschedule', title: localized('btn.reschedule', lang) ?? '🔄 Reschedule' },
  ];
}


export function genericDoctor(lang) {
  return {
    [LANG.URDU]: 'ڈاکٹر',
    [LANG.SINDHI]: 'ڊاڪٽر',
    [LANG.PASHTO]: 'ډاکټر',
    [LANG.BALOCHI]: 'ڈاکٹر',
  }[lang] || 'the doctor';
}

export async function getConversationLanguage(phone) {
  try {
    const conv = await Conversation.findOne({ phone }).select('language').lean();
    return conv?.language || LANG.ROMAN_URDU;
  } catch {
    return LANG.ROMAN_URDU;
  }
}








const MESSAGES = {
  'ask.name': {
    en: "Sure! What's your name?",
    ru: 'Sure! Aapka naam kya hai?',
    ur: 'یقیناً! آپ کا نام کیا ہے؟',
    sd: 'ٺيڪ آهي! توهان جو نالو ڇا آهي؟',
    ps: 'ډاډه! ستاسو نوم څه دی؟',
    bl: 'پڪ! شمہ ناں چی ہے؟',
  },
  'ask.phone': {
    en: 'What is your phone number?',
    ru: 'Aapka phone number kya hai?',
    ur: 'آپ کا فون نمبر کیا ہے؟',
    sd: 'توهان جو فون نمبر ڇا آهي؟',
    ps: 'ستاسو د ټیلیفون شمېره څه ده؟',
    bl: 'شمہ فون نمبر چی ہے؟',
  },
  'ask.reason': {
    en: 'What is the reason for your visit?',
    ru: 'Visit kis wajah se karni hai?',
    ur: 'آنے کی وجہ کیا ہے؟',
    sd: 'توهان جي اچڻ جو سبب ڇا آهي؟',
    ps: 'ستاسو د راتلو سبب څه دی؟',
    bl: 'شمہ ملاقات جو سبب چی ہے؟',
  },
  'ask.datetime': {
    en: 'Which day and what time would you like to come?',
    ru: 'Kis din aur kis waqt aana chahate hain?',
    ur: 'کون سا دن اور کس وقت آنا چاہیں گے؟',
    sd: 'ڪهڙي ڏينهن ۽ ڪهڙي وقت اچڻ چاهيو ٿا؟',
    ps: 'په کومه ورځ او په څه وخت راتلی غواړئ؟',
    bl: 'کہ روچ اے اے کہ چی وہگت آیت؟',
  },
  'book.confirm': {
    en: 'Please confirm:\nDate: {date}  Time: {time}\nName: {name}\nReason: {reason}',
    ru: 'Confirm karein? / Please confirm:\nDate: {date}  Time: {time}\nName: {name}\nReason: {reason}',
    ur: 'براہ کرم تصدیق کریں:\nتاریخ: {date}  وقت: {time}\nنام: {name}\nوجہ: {reason}',
    sd: 'مهرباني ڪري تصديق ڪريو:\nتاريخ: {date}  وقت: {time}\nنالو: {name}\nسبب: {reason}',
    ps: 'مهرباني وکړئ تایید یې کړئ:\nنېټه: {date}  وخت: {time}\nنوم: {name}\nسبب: {reason}',
    bl: 'مہربانی کنہ تصدیق کنیت:\nتاریخ: {date}  وقت: {time}\nنام: {name}\nسبب: {reason}',
  },
  'book.declined': {
    en: 'Okay, no problem. Let us know whenever you would like to book an appointment.',
    ru: 'Okay, no problem. Let us know whenever you would like to book an appointment.',
    ur: 'ٹھیک ہے، کوئی مسئلہ نہیں۔ جب بھی اپائنٹمنٹ چاہیے تو بتا دیجیے گا۔',
    sd: 'ٺيڪ، ڪو مسئلو نه آهي. جيڪڏهن ڪڏهن به اپائنمنٽ چاهيو ته ٻڌايو.',
    ps: 'ښه، هیڅ ستونزه نشته. که بیا که وخت اپائنمنټ غواړئ را خبر کړئ.',
    bl: 'ٹھیک ئے، کو مسئلہ نہ. جب بھی اپائنمنٹ بوتگہ ته ٻڌايو.',
  },
  'book.restart': {
    en: 'Koi baat nahi — let us start over. Which day and what time works for you?',
    ru: 'Koi baat nahi — let us start over. Which day and what time works for you?',
    ur: 'کوئی بات نہیں — پھر سے شروع کرتے ہیں۔ آپ کو کون سا دن اور وقت مناسب رہے گا؟',
    sd: 'ڪا مسئلو نه آهي — ٻيهر شروع ڪريون. توهان کي ڪهڙو ڏينهن ۽ وقت مناسب آهي؟',
    ps: 'هیڅ خبره نشته — بیا شروع وکړو. کومه ورځ او وخت ستاسو سره جوړیږي؟',
    bl: 'کوئ بات نہ — دورہ شروع کنیت. کہ روچ اے کہ وہگت شمہ ریت مناسب ئے؟',
  },
  'slot.taken': {
    en: 'Sorry, {date} at {time} is already taken.',
    ru: 'Sorry, {date} at {time} is already taken.',
    ur: 'معذرت، {date} کو {time} بجے کا وقت پہلے سے بک ہے۔',
    sd: 'معاف ڪجو، {date} تي {time} وڳي جو وقت اڳي ئي بڪ ٿيل آهي.',
    ps: 'بخښنه، {date} د {time} بجو وخت مخکې بک شوی دی.',
    bl: 'بخش، {date} {time} بجے جو وہگت پہلے بک ئے.',
  },
  'slot.alternatives': {
    en: 'Nearest available options:',
    ru: 'Nearest available options:',
    ur: 'قریب ترین دستیاب وقت:',
    sd: 'ويجھا موجود وقت:',
    ps: 'نژدې شته وختونه:',
    bl: 'نزدیک دستیاب وہگت:',
  },
  'slot.none': {
    en: 'I could not find any other free slot in the next 14 days.\nPlease try another day and time, or contact the clinic.',
    ru: 'I could not find any other free slot in the next 14 days.\nPlease try another day and time, or contact the clinic.',
    ur: 'اگلے 14 دنوں میں کوئی اور خالی وقت نہیں ملا۔\nبراہ کرم کوئی اور دن اور وقت آزمائیں، یا کلینک سے رابطہ کریں۔',
    sd: 'ايندڙ 14 ڏينهن ۾ ٻيو ڪو خالي وقت نه مليو.\nٻيو ڏينهن ۽ وقت آزمايو، يا ڪلينڪ سان رابطو ڪريو.',
    ps: 'په راتلونکو 14 ورځو کې بل خالي وخت ونه موندل شو.\nمهرباني وکړئ بله ورځ او وخت وآزمايئ، یا له کلینیک سره اړیکه ونیسئ.',
    bl: 'آینده 14 روچا تا کو دورہ خالی وہگت نہ لبگ.\nمہربانی کنہ دورہ روچ اے وہگت آزمائیت، یا کلینک ساتا رابطہ کنیت۔',
  },
  'slot.choose': {
    en: 'Reply with a number, or tell me another day and time.',
    ru: 'Reply with a number, or tell me another day and time.',
    ur: 'نمبر لکھ کر بتائیں، یا کوئی اور دن اور وقت بتائیں۔',
    sd: 'نمبر لکو، يا ٻيو ڏينهن ۽ وقت ٻڌايو.',
    ps: 'شمېره ولېکئ، یا بله ورځ او وخت راسره ووایاست.',
    bl: 'نمبر لیکیت، یا دورہ روچ اے وہگت باج.',
  },
  'slot.outsideHours': {
    en: "{date} at {time} is outside the clinic's working hours.",
    ru: "{date} at {time} is outside the clinic's working hours.",
    ur: '{date} کو {time} بجے کلینک کے اوقات کار سے باہر ہے۔',
    sd: '{date} تي {time} وڳي ڪلينڪ جي ڪم جي وقت کان ٻاهر آهي.',
    ps: '{date} د {time} بجو د کلینیک د کار وختونو بهر دی.',
    bl: '{date} {time} بجے کلینک جو وہگت نہ ئے.',
  },
  'slot.breakTime': {
    en: 'The clinic is on a break at that time.',
    ru: 'The clinic is on a break at that time.',
    ur: 'اس وقت کلینک آرام/وقفے پر ہے۔',
    sd: 'انهي وقت ڪلينڪ آرام تي آهي.',
    ps: 'په هغه وخت کلینیک په آرام دی.',
    bl: 'ہمہ وہگت کلینک آرام ئے.',
  },
  'slot.inPast': {
    en: 'That time has already passed.',
    ru: 'That time has already passed.',
    ur: 'وہ وقت گزر چکا ہے۔',
    sd: 'اهو وقت گذري ويو آهي.',
    ps: 'هغه وخت تېر شوی دی.',
    bl: 'ہمہ وہگت گزرگ.',
  },
  'reschedule.ask.datetime': {
    en: 'Which new day and what time would you like?',
    ru: 'Kis naye din aur kis waqt par aana chahate hain?',
    ur: 'آپ کس نئے دن اور کس وقت آنا چاہیں گے؟',
    sd: 'توهان ڪهڙي نئين ڏينهن ۽ ڪهڙي وقت اچڻ چاهيو ٿا؟',
    ps: 'ستاسو په کومه نوې ورځ او څه وخت راتلی غواړئ؟',
    bl: 'شمہ کہ نو روچ اے کہ چی وہگت آیگ؟',
  },
  'reschedule.youHave': {
    en: 'You have {count} upcoming appointments.',
    ru: 'Aapke paas {count} upcoming appointments hain.',
    ur: 'آپ کے پاس {count} آئندہ اپوائنٹمنٹس ہیں۔',
    sd: 'توهان وٽ {count} ايندڙ اپائنٽمينٽون آهن.',
    ps: 'ستاسو {count} راتلونکي اپاینټمنټان شته دي.',
    bl: 'شمہ ری {count} آینده اپائنٽمنٹ ئنت.',
  },
  'reschedule.which': {
    en: 'Which one would you like to reschedule?',
    ru: 'Konsi reschedule karni hai?',
    ur: 'آپ کون سی اپوائنٹمنٹ دوبارہ طے کرنا چاہیں گے؟',
    sd: 'ڪهڙي کي ٻيهر ترتيب ڏيارڻ چاهيو ٿا؟',
    ps: 'کومه یوه بيا تيارول غواړئ؟',
    bl: 'کہ یک دورہ ترتیب کنگ لوٹ؟',
  },
  'reschedule.nothing': {
    en: 'You have no upcoming confirmed appointments to reschedule.',
    ru: 'Aapke paas reschedule karne ke liye koi upcoming appointment nahi hai.',
    ur: 'آپ کے پاس دوبارہ طے کرنے کے لیے کوئی آئندہ اپوائنٹمنٹ نہیں ہے۔',
    sd: 'توهان وٽ ٻيهر ترتيب ڏيڻ لاءِ ڪا ايندڙ اپائنٽمينٽ نه آهي.',
    ps: 'ستاسو د بیا تیارولو لپاره کومه راتلونکې تایید شوې اپاینټمنټ نشته.',
    bl: 'شمہ ری دورہ ترتیب کنگ ری کو آینده تصدیق شده اپائنٽمنٹ نہ.',
  },
  'reschedule.notActive': {
    en: 'That appointment is no longer active.',
    ru: 'Wo appointment ab active nahi hai.',
    ur: 'وہ اپوائنٹمنٹ اب فعال نہیں ہے۔',
    sd: 'اها اپائنٽمينٽ هاڻي فعال نه آهي.',
    ps: 'هغه اپاینټمنټ نور فعال نه ده.',
    bl: 'ہمہ اپائنٽمنٹ ہن فعال نہ.',
  },
  'reschedule.noTarget': {
    en: 'Please tell me which appointment to reschedule first.',
    ru: 'Pehle bata dein konsi appointment reschedule karni hai.',
    ur: 'پہلے بتائیں کہ کون سی اپوائنٹمنٹ دوبارہ طے کرنی ہے۔',
    sd: 'اڳي ٻڌايو ته ڪهڙي اپائنٽمينٽ ٻيهر ترتيب ڏيڻي آهي.',
    ps: 'لومړی راسره ووایاست کومه اپاینټمنټ بيا تيارول غواړئ.',
    bl: 'پہلے باج کہ کہ اپائنٽمنٹ دورہ ترتیب کنگ لوٹ.',
  },
  'reschedule.summary': {
    en: 'Please confirm:\nCurrent: {current}\nNew: {new}',
    ru: 'Reschedule karein? / Please confirm:\nCurrent: {current}\nNew: {new}',
    ur: 'براہ کرم تصدیق کریں:\nموجودہ: {current}\nنیا: {new}',
    sd: 'مهرباني ڪري تصديق ڪريو:\nموجوده: {current}\nنئون: {new}',
    ps: 'مهرباني وکړئ تایید یې کړئ:\nاوسنی: {current}\nنوی: {new}',
    bl: 'مہربانی کنہ تصدیق کنیت:\nموجوده: {current}\nنو: {new}',
  },
  'reschedule.done': {
    en: 'Appointment rescheduled. New Token #{tokenNo}.\n{date} at {time} with {doctorName}.',
    ru: 'Appointment reschedule ho gayi. New Token #{tokenNo}.\n{date} ko {time} par {doctorName} ke sath.',
    ur: 'اپوائنٹمنٹ دوبارہ طے ہو گئی۔ نیا ٹوکن #{tokenNo}۔\n{date} کو {time} بجے {doctorName} کے ساتھ۔',
    sd: 'اپائنٽمينٽ ٻيهر ترتيب ٿي وئي. نئون ٽوڪن #{tokenNo}.\n{date} تي {time} وڳي {doctorName} سان.',
    ps: 'اپاینټمنټ بيا تيار شو. نوې ټوکن #{tokenNo}.\n{date} د {time} بجو {doctorName} سره.',
    bl: 'اپائنٽمنٹ دورہ ترتیب بوتگ. نو ٹوکن #{tokenNo}.\n{date} {time} بجے {doctorName} ساتا.',
  },
  'cancel.youHave': {
    en: 'You have {count} upcoming appointments.',
    ru: 'Aapke paas {count} upcoming appointments hain.',
    ur: 'آپ کے پاس {count} آئندہ اپوائنٹمنٹس ہیں۔',
    sd: 'توهان وٽ {count} ايندڙ اپائنٽمينٽون آهن.',
    ps: 'ستاسو {count} راتلونکي اپاینټمنټان شته دي.',
    bl: 'شمہ ری {count} آینده اپائنٽمنٹ ئنت.',
  },
  'cancel.which': {
    en: 'Which one would you like to cancel?',
    ru: 'Konsi cancel karni hai?',
    ur: 'آپ کون سی اپوائنٹمنٹ منسوخ کرنا چاہیں گے؟',
    sd: 'ڪهڙي منسوخ ڪرائڻ چاهيو ٿا؟',
    ps: 'کومه یوه لغوه کول غواړئ؟',
    bl: 'کہ یک کنسل کنگ لوٹ؟',
  },
  'cancel.summary': {
    en: 'Please confirm:\n{line}\nReply YES to cancel, or NO to keep it.',
    ru: 'Cancel karein? / Please confirm:\n{line}\nReply YES to cancel, or NO to keep it.',
    ur: 'براہ کرم تصدیق کریں:\n{line}\nمنسوخ کرنے کے لیے جی ہاں لکھیں، رکھنے کے لیے نہیں۔',
    sd: 'مهرباني ڪري تصديق ڪريو:\n{line}\nمنسوخ ڪرڻ لاءِ ها لکو، رکڻ لاءِ نه.',
    ps: 'مهرباني وکړئ تایید یې کړئ:\n{line}\nد لغوه کولو لپاره هو ولېکئ، د ساتلو لپاره نه.',
    bl: 'مہربانی کنہ تصدیق کنیت:\n{line}\nکنسل کنگ ری ہا لیکیت، رکگ ری نہ۔',
  },
  'cancel.declined': {
    en: 'Okay, no problem. Your appointment stays as it is.',
    ru: 'Okay, no problem. Your appointment stays as it is.',
    ur: 'ٹھیک ہے، کوئی مسئلہ نہیں۔ آپ کی اپوائنٹمنٹ ویسے ہی ہے۔',
    sd: 'ٺيڪ، ڪو مسئلو نه آهي. توهان جي اپائنٽمينٽ جيئن آهي تيئن رهي.',
    ps: 'ښه، هیڅ ستونزه نشته. ستاسو اپاینټمنټ همداسې پاتې ده.',
    bl: 'ٹھیک ئے، کو مسئلہ نہ. شمہ اپائنٽمنٹ پہلوں وانگ ئے.',
  },
  'cancel.nothing': {
    en: 'You have no upcoming confirmed appointments to cancel.',
    ru: 'Aapke paas cancel karne ke liye koi upcoming appointment nahi hai.',
    ur: 'آپ کے پاس منسوخ کرنے کے لیے کوئی آئندہ اپوائنٹمنٹ نہیں ہے۔',
    sd: 'توهان وٽ منسوخ ڪرڻ لاءِ ڪا ايندڙ اپائنٽمينٽ نه آهي.',
    ps: 'ستاسو د لغوه کولو لپاره کومه راتلونکې تایید شوې اپاینټمنټ نشته.',
    bl: 'شمہ ری کنسل کنگ ری کو آینده تصدیق شده اپائنٽمنٹ نہ.',
  },
  'cancel.notActive': {
    en: 'That appointment is no longer active.',
    ru: 'Wo appointment ab active nahi hai.',
    ur: 'وہ اپوائنٹمنٹ اب فعال نہیں ہے۔',
    sd: 'اها اپائنٽمينٽ هاڻي فعال نه آهي.',
    ps: 'هغه اپاینټمنټ نور فعال نه ده.',
    bl: 'ہمہ اپائنٽمنٹ ہن فعال نہ.',
  },
  'cancel.noTarget': {
    en: 'Please tell me which appointment to cancel first.',
    ru: 'Pehle bata dein konsi appointment cancel karni hai.',
    ur: 'پہلے بتائیں کہ کون سی اپوائنٹمنٹ منسوخ کرنی ہے۔',
    sd: 'اڳي ٻڌايو ته ڪهڙي اپائنٽمينٽ منسوخ ڪرڻي آهي.',
    ps: 'لومړی راسره ووایاست کومه اپاینټمنټ لغوه کول غواړئ.',
    bl: 'پہلے باج کہ کہ اپائنٽمنٹ کنسل کنگ لوٹ.',
  },
  'cancel.done': {
    en: 'Appointment cancelled. Token #{tokenNo} ({date} at {time}).',
    ru: 'Appointment cancel ho gayi. Token #{tokenNo} ({date} at {time}).',
    ur: 'اپوائنٹمنٹ منسوخ ہو گئی۔ ٹوکن #{tokenNo} ({date} کو {time} بجے)۔',
    sd: 'اپائنٽمينٽ منسوخ ٿي وئي. ٽوڪن #{tokenNo} ({date} تي {time} وڳي).',
    ps: 'اپاینټمنټ لغوه شوه. ټوکن #{tokenNo} ({date} د {time} بجو).',
    bl: 'اپائنٽمنٹ کنسل بوتگ. ٹوکن #{tokenNo} ({date} {time} بجے).',
  },
  'query.noConfig': {
    en: 'No clinic schedule is configured yet.',
    ru: 'Clinic ka schedule abhi set nahi hua.',
    ur: 'کلینک کا شیڈول ابھی ترتیب نہیں ہوا۔',
    sd: 'ڪلينڪ جو شيڊول اڃا ترتيب نه ٿيو آهي.',
    ps: 'د کلینیک مهالویش لا ترتیب نه شوی.',
    bl: 'کلینک جو پروگرام ہن ترتیب نہ بوتگ.',
  },
  'query.noAppointments': {
    en: 'You have no upcoming appointments.',
    ru: 'Aapke paas koi upcoming appointment nahi hai.',
    ur: 'آپ کے پاس کوئی آئندہ اپوائنٹمنٹ نہیں ہے۔',
    sd: 'توهان وٽ ڪا ايندڙ اپائنٽمينٽ نه آهي.',
    ps: 'ستاسو کومه راتلونکې اپاینټمنټ نشته.',
    bl: 'شمہ ری کو آینده اپائنٽمنٹ نہ.',
  },
  'query.hours': {
    en: 'Clinic hours:',
    ru: 'Clinic hours:',
    ur: 'کلینک کے اوقات:',
    sd: 'ڪلينڪ جا وقت:',
    ps: 'د کلینیک وختونه:',
    bl: 'کلینک جو وہگت:',
  },
  'query.bookHint': {
    en: 'Tell us a date and time to book.',
    ru: 'Book karne ke liye date aur time batayen.',
    ur: 'بکنگ کے لیے تاریخ اور وقت بتائیں۔',
    sd: 'بڪ ڪرائڻ لاءِ تاريخ ۽ وقت ٻڌايو.',
    ps: 'د بک لپاره نېټه او وخت راسره ووایاست.',
    bl: 'بک کنگ ری تاریخ اے وہگت باج.',
  },
  'query.closedDay': {
    en: 'The clinic is closed on {date}.',
    ru: 'The clinic is closed on {date}.',
    ur: 'کلینک {date} کو بند ہے۔',
    sd: 'ڪلينڪ {date} تي بند آهي.',
    ps: 'کلینیک د {date} په ورځ تړلی دی.',
    bl: 'کلینک {date} روچ بند ئے.',
  },
  'query.holiday': {
    en: 'The doctor is closed on {date} (holiday).',
    ru: 'The doctor is closed on {date} (holiday).',
    ur: 'ڈاکٹر {date} کو (چھٹی پر) بند ہیں۔',
    sd: 'ڊاڪٽر {date} تي (موڪل تي) بند آهي.',
    ps: 'ډاکټر د {date} په ورځ (په رخصت) تړلی دی.',
    bl: 'ڈاکٹر {date} روچ (چھٹی) بند ئے.',
  },
  'query.past': {
    en: 'That day is in the past.',
    ru: 'Wo din guzar chuka hai.',
    ur: 'وہ دن گزر چکا ہے۔',
    sd: 'اهو ڏينهن گذري ويو آهي.',
    ps: 'هغه ورځ تېره شوه.',
    bl: 'ہمہ روچ گزرگ.',
  },
  'query.noSlots': {
    en: 'No free slots left on {date}.',
    ru: 'Us din koi free slot nahi bacha.',
    ur: '{date} کو کوئی خالی وقت نہیں بچا۔',
    sd: '{date} تي ڪو خالي وقت نه بچيو.',
    ps: 'د {date} په ورځ کوم خالي وخت نه پاتې.',
    bl: '{date} روچ کو خالی وہگت نہ رہگ.',
  },
  'query.available': {
    en: 'The doctor is available on {date} at:',
    ru: 'The doctor is available on {date} at:',
    ur: 'ڈاکٹر {date} کو ان اوقات میں دستیاب ہیں:',
    sd: 'ڊاڪٽر {date} تي هن وقت تي موجود آهي:',
    ps: 'ډاکټر د {date} په ورځ په دې وختونو کې شته دی:',
    bl: 'ڈاکٹر {date} روچ ان وہگت ئے:',
  },
  'query.whichTime': {
    en: 'Tell me which time works.',
    ru: 'Bata dein kaunsa time theek hai.',
    ur: 'بتائیں کہ کون سا وقت مناسب ہے۔',
    sd: 'ٻڌايو ته ڪهڙو وقت مناسب آهي.',
    ps: 'راسره ووایاست کوم وخت ستاسو سره جوړیږي.',
    bl: 'باج کہ وہگت شمہ ریت مناسب ئے.',
  },
  'query.more': {
    en: 'and {count} more times.',
    ru: 'aur {count} aur times bhi hain.',
    ur: 'اور {count} مزید اوقات بھی ہیں۔',
    sd: '۽ {count} وڌيڪ وقت به آهن.',
    ps: 'او {count} نور وختونه هم شته.',
    bl: 'اے {count} دورہ وہگت ہم ئنت.',
  },
  'query.upcoming': {
    en: 'Your upcoming appointments ({count}):',
    ru: 'Aapke upcoming appointments ({count}):',
    ur: 'آپ کی آئندہ اپوائنٹمنٹس ({count}):',
    sd: 'توهان جون ايندڙ اپائنٽمينٽون ({count}):',
    ps: 'ستاسو راتلونکي اپاینټمنټان ({count}):',
    bl: 'شمہ آینده اپائنٽمنٹ ({count}):',
  },
  'query.anythingElse': {
    en: 'Anything else?',
    ru: 'Kuch aur chahiye?',
    ur: 'کچھ اور چاہیے؟',
    sd: 'ٻيو ڪجهه گهرجي؟',
    ps: 'بل څه؟',
    bl: 'دورہ کچ؟',
  },
  'smalltalk.default': {
    en: "hello, I'm the clinic assistant — I can help you book, reschedule, or check your appointments.",
    ru: "hello, I'm the clinic assistant — I can help you book, reschedule, or check your appointments.",
    ur: 'سلام، میں کلینک اسسٹنٹ ہوں — میں آپ کو اپوائنٹمنٹ بکنگ، دوبارہ طے کرنے یا دیکھنے میں مدد کر سکتا ہوں۔',
    sd: 'سلام، آئون ڪلينڪ اسسٽنٽ آهيان — اپائنٽمينٽ بڪ، ٻيهر ترتيب يا ڏسڻ ۾ مدد ڪري سگهان ٿو.',
    ps: 'سلام، زه د کلینیک مرستیال یم — زه ستاسو د اپاینټمنټ بک، بدلولو یا لیدلو کې مرسته کولی شم.',
    bl: 'سلام، من کلینک مددگار ئاں — اپائنٽمنٹ بک، دورہ ترتیب یا کہن کنگ ری مدد کنگ توان.',
  },
  'unclear': {
    en: 'Sorry, I did not understand. Please rephrase or type MENU.',
    ru: 'Sorry, I did not understand. Please rephrase or type MENU.',
    ur: 'معذرت، میں سمجھ نہیں سکا۔ براہ کرم دوبارہ لکھیں یا MENU ٹائپ کریں۔',
    sd: 'معاف ڪجو، آئون سمجهي نه سگهيس. مهرباني ڪري ٻيهر لکو يا MENU لکو.',
    ps: 'بخښنه، زه پوه نه شوم. مهرباني وکړئ بيا ولېکئ یا MENU وټاپئ.',
    bl: 'بخش، من سمجھ نہ کنگ. مہربانی کنہ دورہ لیکیت یا MENU لیکیت.',
  },
  'voice.unclear': {
    en: "Sorry, I couldn't catch that clearly. Please say it again a bit slowly, or type your message.",
    ru: "Sorry, I couldn't catch that clearly. Please say it again a bit slowly, or type your message.",
    ur: 'معذرت، میں آپ کی بات واضح نہیں سن سکا۔ براہ کرم تھوڑا آہستہ دوبارہ کہیں، یا اپنا پیغام لکھیں۔',
    sd: 'معاف ڪجو، توهان جي ڳالهه واضح نه ٻڌي سگهيس. مهرباني ڪري ٿورو سست ٻيهر چئو، يا پيغام لکو.',
    ps: 'بخښنه، ستاسو خبره په واضح ډول ونه اورېدله. مهرباني وکړئ لږ ورو بيا يې ووايئ، یا خپل پېغام ولېکئ.',
    bl: 'بخش، شمہ بات واضح نہ کنگ. مہربانی کنہ تہو لوٹ آہستہ باج، یا پیغام لیکیت.',
  },
  'voice.guided': {
    en: "I can help you book an appointment. Please tell me your name, or type MENU for options.",
    ru: "I can help you book an appointment. Please tell me your name, or type MENU for options.",
    ur: 'میں آپ کو اپوائنٹمنٹ بک کرنے میں مدد کر سکتا ہوں۔ براہ کرم اپنا نام بتائیں، یا OPTIONS کے لیے MENU لکھیں۔',
    sd: 'مان توهان جي ملاقات ڪري سگهان ٿو. مهرباني ڪري پنھنجو نالو وallo، يا options لاء MENU لکو.',
    ps: 'زه ستاسو د وړتیا وឆاړه لکولی شم. مهرباني وکړئ خپله نوم وړانګېدل، یا د انتخاباتو لپاره MENU ولیکئ.',
    bl: 'میں تہاں د ملاقات بکنگ میں مدد کر سکتاں۔ مہربانی کنہ اپنا نام وتو، یا options لیت MENU لیکیت۔',
  },
  'voice.unavailable': {
    en: "Sorry, I can't process voice messages right now. Please type your message and I'll help you.",
    ru: "Sorry, I can't process voice messages right now. Please type your message and I'll help you.",
    ur: 'معذرت، فی الحال صوتی پیغامات پر کارروائی ممکن نہیں ہے۔ براہ کرم اپنا پیغام لکھیں، میں آپ کی مدد کروں گا۔',
    sd: 'معاف ڪجو، هاڻي سائو پيغامن تي ڪاريابائي نه ٿي سگهي. مهرباني ڪري پنھنجو پيغام لکو، مان توهان جي مدد ڪريان.',
    ps: 'بخښنه، اوس د غوږی پېغامونو پر کاروbarangی نشته. مهرباني وکړئ خپل پېغام ولېکئ، زه ستاسو مرسته کولی شم.',
    bl: 'بخش، ہن صوتی پیغامات پر کارروائی نہ۔ مہربانی کنہ اپنا پیغام لیکیت، من تہاں د مدد کنگ۔',
  },
  'busy': {
    en: 'System is busy right now — please try again in a moment.',
    ru: 'System is busy right now — please try again in a moment.',
    ur: 'سسٹم ابھی مصروف ہے — براہ کرم تھوڑی دیر بعد دوبارہ کوشش کریں۔',
    sd: 'سسٽم هاڻي مصروف آهي — ٿورو دير بعد ٻيهر ڪوشش ڪريو.',
    ps: 'سیسټم اوس بوخت دی — مهرباني وکړئ یو څه وروسته بیا هڅه وکړئ.',
    bl: 'سسٹم ہن مصروف ئے — مہربانی کنہ تہو دیر پی دورہ کوشش کنیت۔',
  },
  'error': {
    en: 'Something went wrong on our side — please try again shortly, or contact the clinic.',
    ru: 'Something went wrong on our side — please try again shortly, or contact the clinic.',
    ur: 'ہماری طرف سے کچھ غلطی ہو گئی — براہ کرم تھوڑی دیر بعد دوبارہ کوشش کریں، یا کلینک سے رابطہ کریں۔',
    sd: 'اسان وٽ ڪا غلطي ٿي — ٿورو دير بعد ٻيهر ڪوشش ڪريو، يا ڪلينڪ سان رابطو ڪريو.',
    ps: 'زموږ له لوري څه تېروتنه وشوه — مهرباني وکړئ څه وروسته بیا هڅه وکړئ، یا له کلینیک سره اړیکه ونیسئ.',
    bl: 'مہاں پہلی کچ غلطی بوتگ — مہربانی کنہ تہو دیر پی کوشش کنیت، یا کلینک ساتا رابطہ کنیت۔',
  },
  'stub': {
    en: 'I can help you book a new appointment for now — other options are coming soon.',
    ru: 'I can help you book a new appointment for now — other options are coming soon.',
    ur: 'میں ابھی نیا اپوائنٹمنٹ بکنگ میں مدد کر سکتا ہوں — دیگر اختیارات جلد آ رہے ہیں۔',
    sd: 'آئون هاڻي نئين اپائنٽمينٽ بڪ ڪرائڻ ۾ مدد ڪري سگهان ٿو — ٻيا اختيار جلد ايندا.',
    ps: 'زه اوس نوې اپاینټمنټ بک کولو کې مرسته کولی شم — نور انتخابونه ډیر ژر راځي.',
    bl: 'من ہن نو اپائنٽمنٹ بک کنگ ری مدد کنگ توان — دورہ اختیار جلدی آیت.',
  },
  'confirm.done': {
    en: '✅ Appointment confirmed. Token #{tokenNo}.\n{date} at {time}{withDoctor}.\nReason: {reason}',
    ru: '✅ Appointment confirm ho gayi. Token #{tokenNo}.\n{date} ko {time} par{withDoctor}.\nWajah: {reason}',
    ur: '✅ اپوائنٹمنٹ تصدیق ہو گئی۔ ٹوکن #{tokenNo}۔\n{date} کو {time} بجے{withDoctor}۔\nوجہ: {reason}',
    sd: '✅ اپائنٽمينٽ تصديق ٿي وئي. ٽوڪن #{tokenNo}.\n{date} تي {time} وڳي{withDoctor}.\nسبب: {reason}',
    ps: '✅ اپاینټمنټ تایید شو. ټوکن #{tokenNo}.\n{date} د {time} بجو{withDoctor}.\nسبب: {reason}',
    bl: '✅ اپائنٽمنٹ تصدیق بوتگ. ٹوکن #{tokenNo}.\n{date} {time} بجے{withDoctor}.\nسبب: {reason}',
  },
  'reminder': {
    en: '⏰ Reminder: your appointment (Token #{tokenNo}) is on {date} at {time}.',
    ru: '⏰ Yaad dahani: aapki appointment (Token #{tokenNo}) {date} ko {time} par hai.',
    ur: '⏰ یاد دہانی: آپ کی اپوائنٹمنٹ (ٹوکن #{tokenNo}) {date} کو {time} بجے ہے۔',
    sd: '⏰ ياد ڏياريندڙ: توهان جي اپائنٽمينٽ (ٽوڪن #{tokenNo}) {date} تي {time} وڳي آهي.',
    ps: '⏰ یادونه: ستاسو اپاینټمنټ (ټوکن #{tokenNo}) د {date} په {time} بجو ده.',
    bl: '⏰ یاد گیت: شمہ اپائنٽمنٹ (ٹوکن #{tokenNo}) {date} {time} بجے ئے.',
  },
  'admin.cancelled': {
    en: '❌ Your appointment (Token #{tokenNo}) for {date} at {time}{withDoctor} was cancelled by the clinic.\nPlease send us a message or call to rebook.',
    ru: '❌ Aapki appointment (Token #{tokenNo}) {date} ko {time} par{withDoctor} clinic ne cancel kar di hai.\nDobara book karne ke liye message ya call karein.',
    ur: '❌ آپ کی اپوائنٹمنٹ (ٹوکن #{tokenNo}) جو {date} کو {time} بجے{withDoctor} تھی، کلینک نے منسوخ کر دی۔\nدوبارہ بکنگ کے لیے پیغام بھیجیں یا کال کریں۔',
    sd: '❌ توهان جي اپائنٽمينٽ (ٽوڪن #{tokenNo}) {date} تي {time} وڳي{withDoctor} ڪلينڪ رد ڪئي.\nٻيهر بڪ ڪرائڻ لاءِ پيغام يا ڪال ڪريو.',
    ps: '❌ ستاسو اپاینټمنټ (ټوکن #{tokenNo}) د {date} په {time} بجو{withDoctor} کلینیک لغوه کړه.\nد بیا بک لپاره پېغام ولېږئ یا کال وکړئ.',
    bl: '❌ شمہ اپائنٽمنٹ (ٹوکن #{tokenNo}) {date} {time} بجے{withDoctor} کلینک کنسل کتگ.\nدورہ بک کنگ ری پیغام یا کال کنیت۔',
  },
  'admin.rescheduled': {
    en: '🔄 Your appointment (Token #{tokenNo}) was rescheduled by the clinic.\nOld: {date} at {time}.\nNew: {newDate} at {newTime}{withDoctor}.\nReply CANCEL or RESCHEDULE if this does not work for you.',
    ru: '🔄 Aapki appointment (Token #{tokenNo}) clinic ne reschedule kar di hai.\nOld: {date} at {time}.\nNew: {newDate} at {newTime}{withDoctor}.\nAgar yeh theek nahi hai to CANCEL ya RESCHEDULE likhein.',
    ur: '🔄 آپ کی اپوائنٹمنٹ (ٹوکن #{tokenNo}) کلینک نے دوبارہ طے کی۔\nپرانا: {date} کو {time} بجے۔\nنیا: {newDate} کو {newTime} بجے{withDoctor}۔\nاگر یہ مناسب نہ ہو تو CANCEL یا RESCHEDULE لکھیں۔',
    sd: '🔄 توهان جي اپائنٽمينٽ (ٽوڪن #{tokenNo}) ڪلينڪ ٻيهر ترتيب ڏني.\nاڳوڻو: {date} تي {time} وڳي.\nنئون: {newDate} تي {newTime} وڳي{withDoctor}.\nجيڪڏهن اهو مناسب نه هجي ته CANCEL يا RESCHEDULE لکو.',
    ps: '🔄 ستاسو اپاینټمنټ (ټوکن #{tokenNo}) کلینیک بيا تيار کړه.\nزوړ: {date} د {time} بجو.\nنوی: {newDate} د {newTime} بجو{withDoctor}.\nکه دا مناسب نه وي نو CANCEL یا RESCHEDULE ولېکئ.',
    bl: '🔄 شمہ اپائنٽمنٹ (ٹوکن #{tokenNo}) کلینک دورہ ترتیب کتگ.\nپرانا: {date} {time} بجے.\nنو: {newDate} {newTime} بجے{withDoctor}.\nاگر ہمہ مناسب نہ بوتگہ CANCEL یا RESCHEDULE لیکیت.',
  },
  'reschedule.proposal': {
    en: 'Your appointment on {date} at {time} needs to be rescheduled.\n\nNew time: {newDate} at {newTime}.\n\nDo you accept?',
    ru: 'Your appointment on {date} at {time} needs to be rescheduled.\n\nNew time: {newDate} at {newTime}.\n\nDo you accept?',
    ur: 'آپ کی اپوائنٹمنٹ {date} کو {time} بجے دوبارہ طے کرنی ہے۔\n\nنیا وقت: {newDate} کو {newTime} بجے۔\n\nکیا آپ منظور کرتے ہیں؟',
    sd: 'توهان جي اپائنٽمينٽ {date} تي {time} وڳي ٻيهر ترتيب ڪرڻي آهي.\n\nنئون وقت: {newDate} تي {newTime} وڳي.\n\nڇا توهان منظور ڪريو ٿا؟',
    ps: 'ستاسو اپاینټمنټ د {date} په {time} بجو بيا تيارولو ته اړتیا ده.\n\nنوی وخت: د {newDate} په {newTime} بجو.\n\nایا تاسې منئ؟',
    bl: 'شمہ اپائنٽمنٹ {date} {time} بجے دورہ ترتیب کنگ لوٹ.\n\nنو وہگت: {newDate} {newTime} بجے.\n\nشمہ منظور کنیت؟',
  },
  'reschedule.confirmed': {
    en: '✅ Done! Your appointment (Token #{tokenNo}) is now {newDate} at {newTime}.\nSee you there!',
    ru: '✅ Done! Aapki appointment (Token #{tokenNo}) ab {newDate} ko {newTime} par hai.\nWahan milte hain!',
    ur: '✅ ہو گیا! آپ کی اپوائنٹمنٹ (ٹوکن #{tokenNo}) اب {newDate} کو {newTime} بجے ہے۔\nوہاں ملیں گے!',
    sd: '✅ ٿي ويو! توهان جي اپائنٽمينٽ (ٽوڪن #{tokenNo}) هاڻي {newDate} تي {newTime} وڳي آهي.\nاتي ملون ٿا!',
    ps: '✅ تر سره شو! ستاسو اپاینټمنټ (ټوکن #{tokenNo}) اوس {newDate} د {newTime} بجو ده.\nهلته به ګورو!',
    bl: '✅ بوتگ! شمہ اپائنٽمنٹ (ٹوکن #{tokenNo}) ہن {newDate} {newTime} بجے ئے.\nاوتا ملگ!',
  },
  'reschedule.declined': {
    en: 'No problem — your appointment (Token #{tokenNo}) stays on {date} at {time}.\nThe clinic will contact you separately if they need to find another time.',
    ru: 'No problem — your appointment (Token #{tokenNo}) stays on {date} at {time}.\nThe clinic will contact you separately if they need to find another time.',
    ur: 'کوئی مسئلہ نہیں — آپ کی اپوائنٹمنٹ (ٹوکن #{tokenNo}) {date} کو {time} بجے ہی ہے۔\nاگر دوسرا وقت درکار ہوا تو کلینک آپ سے الگ سے رابطہ کرے گا۔',
    sd: 'ڪو مسئلو نه آهي — توهان جي اپائنٽمينٽ (ٽوڪن #{tokenNo}) {date} تي {time} وڳي ئي آهي.\nجيڪڏهن ٻيو وقت گهرجي ته ڪلينڪ توهان سان الڳ رابطو ڪندو.',
    ps: 'هیڅ ستونزه نشته — ستاسو اپاینټمنټ (ټوکن #{tokenNo}) د {date} په {time} بجو ده.\nکه بل وخت ضروري وي کلینیک به له تاسو سره جلا اړیکه ونیسي.',
    bl: 'کوئ مسئلہ نہ — شمہ اپائنٽمنٹ (ٹوکن #{tokenNo}) {date} {time} بجے ئے.\nاگر دورہ وہگت لوٹ بوتگہ کلینک شمہ ساتا الگ رابطہ کنگ.',
  },
  'reschedule.expired': {
    en: 'Your appointment (Token #{tokenNo}) was NOT moved.\nThe proposed {date} reschedule expired before you could answer, so nothing changed — your appointment stays on your original time.\nThe clinic will contact you if a new time is still needed.',
    ru: 'Your appointment (Token #{tokenNo}) was NOT moved.\nThe proposed {date} reschedule expired before you could answer, so nothing changed — your appointment stays on your original time.\nThe clinic will contact you if a new time is still needed.',
    ur: 'آپ کی اپوائنٹمنٹ (ٹوکن #{tokenNo}) منتقل نہیں ہوئی۔\n{date} کی دوبارہ طے کرنے کی تجویز جواب دینے سے پہلے ختم ہو گئی، اس لیے کچھ نہیں بدلا — آپ کی اپوائنٹمنٹ اپنے اصل وقت پر ہے۔\nاگر اب بھی نیا وقت درکار ہو تو کلینک آپ سے رابطہ کرے گا۔',
    sd: 'توهان جي اپائنٽمينٽ (ٽوڪن #{tokenNo}) منتقل نه ٿي.\n{date} جي ٻيهر ترتيب جي تجويز جواب ڏيڻ کان اڳ ختم ٿي وئي، تنهنڪري ڪجهه نه بدليو — توهان جي اپائنٽمينٽ پنهنجي اصل وقت تي آهي.\nجيڪڏهن اڃا نئون وقت گهرجي ته ڪلينڪ رابطو ڪندو.',
    ps: 'ستاسو اپاینټمنټ (ټوکن #{tokenNo}) منتقله نه شوه.\nد {date} د بيا تيارولو وړاندیز مخکې له دې چې تاسې ځواب ورکړئ پای ته ورسېد، نو هیڅ نه بدلېدل — ستاسو اپاینټمنټ په خپل اصلي وخت پاتې ده.\nکه بیا هم نوی وخت اړین وي کلینیک به له تاسو سره اړیکه ونیسي.',
    bl: 'شمہ اپائنٽمنٹ (ٹوکن #{tokenNo}) منتقل نہ بوتگ.\n{date} جو دورہ ترتیب کنگ تجویز جواب دیتگ پہلے ختم بوتگ، پاسو کچ نہ بدلگ — شمہ اپائنٽمنٹ پہلوں وہگت ئے.\nاگر ہن ہم دورہ وہگت لوٹ کلینک رابطہ کنگ.',
  },
  'reschedule.alreadyHandled': {
    en: 'This reschedule request has already been handled. Please message the clinic if you need anything else.',
    ru: 'This reschedule request has already been handled. Please message the clinic if you need anything else.',
    ur: 'یہ دوبارہ طے کرنے کی درخواست پہلے ہی نمٹائی جا چکی ہے۔ اگر کچھ اور درکار ہو تو کلینک کو پیغام بھیجیں۔',
    sd: 'هي ٻيهر ترتيب جي درخواست اڳي ئي نمٽجي چڪي آهي. جيڪڏهن ٻيو ڪجهه گهرجي ته ڪلينڪ کي پيغام موڪليو.',
    ps: 'د بيا تيارولو غوښتنه مخکې تر سره شوې ده. که بل څه درکار وي نو کلینیک ته پېغام ولېږئ.',
    bl: 'ہمہ دورہ ترتیب درخواست پہلے نمٹگ. اگر دورہ کچ لوٹ کلینک ری پیغام باج۔',
  },
  'reschedule.slotLost': {
    en: 'Sorry, that reschedule time is no longer available. Your appointment stays at your original time — please message the clinic to arrange a new time.',
    ru: 'Sorry, that reschedule time is no longer available. Your appointment stays at your original time — please message the clinic to arrange a new time.',
    ur: 'معذرت، وہ دوبارہ طے شدہ وقت اب دستیاب نہیں۔ آپ کی اپوائنٹمنٹ اپنے اصل وقت پر ہے — نیا وقت طے کرنے کے لیے کلینک کو پیغام بھیجیں۔',
    sd: 'معاف ڪجو، اهو ٻيهر ترتيب ٿيل وقت هاڻي موجود نه آهي. توهان جي اپائنٽمينٽ پنهنجي اصل وقت تي آهي — نئون وقت مقرر ڪرڻ لاءِ ڪلينڪ کي پيغام موڪليو.',
    ps: 'بخښنه، هغه د بيا تيارولو وخت نور شتون نه لري. ستاسو اپاینټمنټ په خپل اصلي وخت ده — د نوي وخت لپاره کلینیک ته پېغام ولېږئ.',
    bl: 'بخش، ہمہ دورہ ترتیب وہگت ہن نہ ئے. شمہ اپائنٽمنٹ پہلوں وہگت ئے — نو وہگت کنگ ری کلینک ری پیغام باج۔',
  },
  'btn.confirmYes': {
    en: '✅ Yes, confirm',
    ru: '✅ Yes, confirm',
    ur: '✅ جی ہاں، تصدیق کریں',
    sd: '✅ ها، تصديق ڪريو',
    ps: '✅ هو، تایید یې کړئ',
    bl: '✅ ہا، تصدیق کنیت',
  },
  'btn.confirmNo': {
    en: '✏️ No, change',
    ru: '✏️ No, change',
    ur: '✏️ نہیں، تبدیلی کریں',
    sd: '✏️ نه، تبديلي',
    ps: '✏️ نه، بدلون',
    bl: '✏️ نہ، تبدیلی',
  },
  'btn.cancel': {
    en: '❌ Cancel',
    ru: '❌ Cancel',
    ur: '❌ منسوخ کریں',
    sd: '❌ رد ڪريو',
    ps: '❌ لغوه کول',
    bl: '❌ کنسل کنیت',
  },
  'btn.reschedule': {
    en: '🔄 Reschedule',
    ru: '🔄 Reschedule',
    ur: '🔄 دوبارہ طے کریں',
    sd: '🔄 ٻيهر ترتيب ڏيو',
    ps: '🔄 بيا تيارول',
    bl: '🔄 دورہ ترتیب کنیت',
  },
};
