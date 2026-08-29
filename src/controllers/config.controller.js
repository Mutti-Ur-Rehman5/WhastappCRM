import { DoctorConfig } from '../models/DoctorConfig.model.js';
import { getDoctorConfig, invalidateDoctorConfigCache, isSlotValid } from '../services/slot.service.js';
import { Appointment } from '../models/Appointment.model.js';
import { logAudit } from '../services/audit.service.js';
import { validateOrThrow } from '../validators/validate.js';
import { configPutSchema } from '../validators/config.validator.js';
import { todayInClinicTimeZone } from '../utils/datetime.util.js';
import { logger } from '../utils/logger.js';







function summarize(config) {
  return {
    workingHours: config.workingHours,
    holidays: config.holidays || [],
    bufferMinutes: config.bufferMinutes,
    maxPerSlot: config.maxPerSlot,
    maxTokensPerDay: config.maxTokensPerDay,
    reminderOffsetsHours: config.reminderOffsetsHours,
  };
}







async function dropLegacySlotUniqueIndex() {
  try {
    const { Appointment } = await import('../models/Appointment.model.js');
    const indexes = await Appointment.collection.indexes();
    for (const idx of indexes) {
      if (idx.key && idx.key.doctorId === 1 && idx.key.date === 1 && idx.key.time === 1 && idx.key.slotSeq === undefined) {
        await Appointment.collection.dropIndex(idx.name);
      }
    }
  } catch (err) {
    logger.warn('Could not drop legacy slot unique index (best-effort)', { err: err.message });
  }
}

function notFound(res) {
  return res.status(404).json({ error: 'DoctorConfig not found', code: 'CONFIG_NOT_FOUND' });
}

export async function getConfig(req, res) {
  const config = await getDoctorConfig();
  if (!config) return notFound(res);

  const today = todayInClinicTimeZone();
  const todayBookedCount = await Appointment.countDocuments({
    doctorId: config._id,
    date: today,
    status: { $in: ['pending', 'confirmed'] },
  });

  res.json({ ...config, todayBookedCount, todayDate: today });
}

export async function putConfig(req, res) {
  const body = validateOrThrow(configPutSchema, req.body);

  const resolved = await getDoctorConfig();
  if (!resolved) return notFound(res);

  const doc = await DoctorConfig.findById(resolved._id);
  if (!doc) return notFound(res);

  const before = summarize(doc);
  doc.workingHours = body.workingHours;
  if (body.holidays !== undefined) doc.holidays = body.holidays;
  if (body.bufferMinutes !== undefined) doc.bufferMinutes = body.bufferMinutes;
  if (body.maxPerSlot !== undefined) doc.maxPerSlot = body.maxPerSlot;
  if (body.maxTokensPerDay !== undefined) doc.maxTokensPerDay = body.maxTokensPerDay;
  if (body.reminderOffsetsHours !== undefined) doc.reminderOffsetsHours = body.reminderOffsetsHours;
  await doc.save();




  if (doc.maxPerSlot > 1) await dropLegacySlotUniqueIndex();


  await invalidateDoctorConfigCache({ doctorId: doc._id });

  await logAudit({
    entity: 'config',
    entityId: doc._id,
    action: 'config_updated',
    actor: 'admin',
    before,
    after: summarize(doc),
  });






  const scheduleConflicts = await findScheduleConflicts({ doctorId: doc._id, config: doc });

  logger.info('Admin updated DoctorConfig', { configId: String(doc._id), conflicts: scheduleConflicts.count });




  const tokenCapConflicts = await findTokenCapConflicts({ doctorId: doc._id, maxTokensPerDay: doc.maxTokensPerDay });

  res.json({ config: doc.toObject(), cacheInvalidated: true, scheduleConflicts, tokenCapConflicts });
}

async function findScheduleConflicts({ doctorId, config }) {
  const active = await Appointment.find({
    doctorId,
    status: { $in: ['pending', 'confirmed'] },
    slotStart: { $gte: new Date() },
  })
    .select('tokenNo date time patientName reason slotStart')
    .sort({ slotStart: 1 })
    .lean();

  const invalid = active.filter((a) => !isSlotValid(config, a.date, a.time).ok);
  return {
    count: invalid.length,
    examples: invalid.slice(0, 20).map((a) => ({
      tokenNo: a.tokenNo,
      date: a.date,
      time: a.time,
      patientName: a.patientName,
      reason: a.reason || '',
    })),
  };
}

async function findTokenCapConflicts({ doctorId, maxTokensPerDay }) {
  if (!maxTokensPerDay) return { count: 0, examples: [] };

  const pipeline = [
    { $match: { doctorId, status: { $in: ['pending', 'confirmed'] }, slotStart: { $gte: new Date() } } },
    { $group: { _id: '$date', count: { $sum: 1 } } },
    { $match: { count: { $gte: maxTokensPerDay } } },
    { $sort: { _id: 1 } },
    { $limit: 20 },
  ];
  const overLimit = await Appointment.aggregate(pipeline);
  return {
    count: overLimit.length,
    examples: overLimit.map((d) => ({ date: d._id, booked: d.count, maxTokensPerDay })),
  };
}
