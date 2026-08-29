import mongoose from 'mongoose';
import { env } from '../../src/config/env.js';

// Tests run against the real local replica set (docker-compose mongo, rs0).
// RULES.md requires mocking only external APIs (WhatsApp/Gemini/Sheets/SMTP);
// Mongo is the system under test here, and the concurrency DoD needs it.
export async function connectTestDb() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 8000,
      autoIndex: true,
    });
  }
  return mongoose.connection;
}

export async function closeTestDb() {
  await mongoose.disconnect();
}
