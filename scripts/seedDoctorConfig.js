import { connectDb, disconnectDb } from '../src/config/db.js';
import { DoctorConfig, WEEKDAYS } from '../src/models/DoctorConfig.model.js';
import { logger } from '../src/utils/logger.js';

// Mon–Sat 09:00–17:00, 15-min slots, no breaks/holidays (per PHASES.md).
// doctorPhone is a placeholder E.164 — set the real number via the admin API
// (/api/config) once deployed.
const defaultConfig = {
  doctorName: 'Dr. Default',
  doctorPhone: '+923001234567',
  timezone: 'Asia/Karachi',
  workingHours: WEEKDAYS.slice(0, 6).map((day) => ({
    day,
    enabled: true,
    start: '09:00',
    end: '17:00',
    slotMinutes: 15,
    breaks: [],
  })),
  holidays: [],
  bufferMinutes: 5,
  maxPerSlot: 1,
  reminderOffsetsHours: [24, 2],
  googleSheetId: '',
  notifyDoctorOn: ['booked', 'cancelled', 'rescheduled'],
};

// Upsert by doctorName so the script is safe to re-run (no duplicate configs).
await connectDb();
const config = await DoctorConfig.findOneAndUpdate(
  { doctorName: defaultConfig.doctorName },
  { $set: defaultConfig },
  { upsert: true, new: true, setDefaultsOnInsert: true },
);
logger.info(`DoctorConfig seeded: id=${config.id} name=${config.doctorName} timezone=${config.timezone}`);
await disconnectDb();
