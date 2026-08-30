import dotenv from 'dotenv';
import { existsSync } from 'node:fs';

dotenv.config();




const REQUIRED_AT_BOOT = [
  'NODE_ENV',
  'PORT',
  'MONGO_URI',
  'REDIS_HOST',
  'REDIS_PORT',
  'CLINIC_TIMEZONE',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_TOKEN',
  'WHATSAPP_API_VERSION',
  'GEMINI_API_KEY',
  'GOOGLE_SHEET_ID',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
];




const GOOGLE_CRED_SOURCES = [
  'GOOGLE_APPLICATION_CREDENTIALS_PATH',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_SERVICE_ACCOUNT_JSON_PATH',
];



const REQUIRED_IN_PRODUCTION = [
  'DOCTOR_EMAIL',
  'ADMIN_API_KEY',
  'JWT_SECRET',
];

function failWithMissing(missing, context) {
  console.error(`[env] Missing required environment variable(s) ${context}:`);
  for (const key of missing) console.error(`  - ${key}`);
  console.error('[env] Copy .env.example to .env, fill every value, then restart.');
  process.exit(1);
}

const missingAtBoot = REQUIRED_AT_BOOT.filter((key) => !process.env[key]);
if (missingAtBoot.length > 0) failWithMissing(missingAtBoot, 'at boot');

const configuredGoogleCredSources = GOOGLE_CRED_SOURCES.filter((key) => process.env[key]);
if (configuredGoogleCredSources.length === 0) {
  failWithMissing(GOOGLE_CRED_SOURCES, 'at boot (Google Sheets: set at least one source)');
}
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_PATH && !existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS_PATH)) {
  console.error(`[env] GOOGLE_APPLICATION_CREDENTIALS_PATH points to a missing file: ${process.env.GOOGLE_APPLICATION_CREDENTIALS_PATH}`);
  console.error('[env] Put the service-account JSON key there (see .env.example) and restart.');
  process.exit(1);
}

const isProduction = process.env.NODE_ENV === 'production';
if (isProduction) {
  const missingProd = REQUIRED_IN_PRODUCTION.filter((key) => !process.env[key]);
  if (missingProd.length > 0) failWithMissing(missingProd, 'in production');
}







let effectiveAdminPasswordHash = process.env.ADMIN_PASSWORD_HASH || '';

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV,
  isProduction,
  port: Number(process.env.PORT),
  logLevel: process.env.LOG_LEVEL || 'info',
  selfPingUrl: process.env.SELF_PING_URL || '',
  clinicTimezone: process.env.CLINIC_TIMEZONE,
  mongoUri: process.env.MONGO_URI,
  redis: Object.freeze({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    username: process.env.REDIS_USERNAME || '',
    password: process.env.REDIS_PASSWORD || '',
    tls: process.env.REDIS_TLS !== 'false',
  }),
  whatsapp: Object.freeze({
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    token: process.env.WHATSAPP_TOKEN || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',


    voiceEnabled: process.env.WHATSAPP_VOICE_ENABLED !== 'false',
  }),


  inboundQueueName: process.env.INBOUND_QUEUE_NAME || 'inbound-message',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',



  geminiTtsModel: process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview',
  geminiTtsVoice: process.env.GEMINI_TTS_VOICE || 'Kore',


  ffmpegPath: process.env.FFMPEG_PATH || '',







  voiceReplyUnsupportedLanguages: process.env.VOICE_REPLY_UNSUPPORTED_LANGUAGES || 'punjabi,sindhi,balochi',
  google: Object.freeze({


    applicationCredentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS_PATH || '',

    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    serviceAccountJsonPath: process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH || '',
    sheetId: process.env.GOOGLE_SHEET_ID || '',
  }),


  sheetsQueueName: process.env.SHEETS_QUEUE_NAME || 'sheets-sync',
  notifyDoctorQueueName: process.env.NOTIFY_DOCTOR_QUEUE_NAME || 'notify-doctor',
  notifyPatientQueueName: process.env.NOTIFY_PATIENT_QUEUE_NAME || 'notify-patient',
  remindersQueueName: process.env.REMINDERS_QUEUE_NAME || 'reminders',
  rescheduleTimeoutQueueName: process.env.RESCHEDULE_TIMEOUT_QUEUE_NAME || 'reschedule-timeout',
  smtp: Object.freeze({
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  }),


  webhookRateLimit: Number(process.env.WEBHOOK_RATE_LIMIT || 300),
  webhookRateLimitWindowMs: Number(process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS || 60_000),
  doctorEmail: process.env.DOCTOR_EMAIL || '',
  frontendUrl: process.env.FRONTEND_URL || '',
  corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS || '',




  adminEmail: process.env.ADMIN_EMAIL || process.env.DOCTOR_EMAIL || '',
  adminApiKey: process.env.ADMIN_API_KEY || '',
  jwtSecret: process.env.JWT_SECRET || '',





  get adminPasswordHash() {
    return effectiveAdminPasswordHash;
  },
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminSessionCookieName: process.env.ADMIN_SESSION_COOKIE_NAME || 'admin_session',
  adminSessionTtlSeconds: Number(process.env.ADMIN_SESSION_TTL_SECONDS || 8 * 60 * 60),




  rescheduleConfirmationTimeoutMs: Number(process.env.RESCHEDULE_CONFIRMATION_TIMEOUT_HOURS || 24) * 60 * 60 * 1000,
});

export function setAdminPasswordHash(value) {
  effectiveAdminPasswordHash = value;
}
