import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env file from Backend root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const requiredEnv = [
  'PORT',
  'MONGO_URI',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'CLIENT_URL'
];

for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    console.warn(`[WARN] Missing environment variable: ${envVar}`);
  }
}

export const env = {
  PORT: process.env.PORT || 5000,
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/wacrm',
  JWT_SECRET: process.env.JWT_SECRET || 'fallback_secret_jwt_key_12345',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'fallback_refresh_secret_key_54321',
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',
};
