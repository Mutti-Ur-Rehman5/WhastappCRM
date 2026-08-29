import cron from 'node-cron';
import { Appointment, APPOINTMENT_STATUSES } from '../models/Appointment.model.js';
import { logAudit } from '../services/audit.service.js';
import { env } from '../config/env.js';
import { getSheetsClient, rebuildRowMapImpl, SHEET_RANGE } from '../services/sheets.service.js';
import { enqueueSheetSync } from '../queues/sheetsSync.queue.js';
import { withRetry } from '../utils/retry.util.js';
import { logger } from '../utils/logger.js';
















export const HEADER_ROW = 1;
const COL_STATUS = 5;
const COL_UPDATED_AT = 6;
const COL_NOTES = 7;

export async function applySheetEdit({ tokenNo, row }) {
  const appointment = await Appointment.findOne({ tokenNo });
  if (!appointment) return { tokenNo, applied: false, reason: 'not_found' };

  const sheetStatus = row[COL_STATUS];
  const sheetNotes = row[COL_NOTES];
  const sheetUpdatedAt = new Date(row[COL_UPDATED_AT] ?? '');
  if (Number.isNaN(sheetUpdatedAt.getTime())) {
    return { tokenNo, applied: false, reason: 'unparseable_timestamp' };
  }
  const dbUpdatedAt = appointment.updatedAt;
  if (dbUpdatedAt && sheetUpdatedAt.getTime() < dbUpdatedAt.getTime()) {
    return { tokenNo, applied: false, reason: 'db_newer' };
  }

  const changed = {};
  if (sheetStatus && sheetStatus !== appointment.status) {
    if (!APPOINTMENT_STATUSES.includes(sheetStatus)) {
      logger.warn('Ignoring sheet status not in the appointment enum', { tokenNo, status: sheetStatus });
    } else {
      changed.status = sheetStatus;
    }
  }
  if (typeof sheetNotes === 'string' && sheetNotes !== (appointment.notes || '')) {
    changed.notes = sheetNotes;
  }
  if (Object.keys(changed).length === 0) {
    return { tokenNo, applied: false, reason: 'unchanged' };
  }

  const before = { status: appointment.status, notes: appointment.notes || '' };
  await Appointment.updateOne({ _id: appointment._id }, { $set: changed });


  await logAudit({
    entity: 'appointment',
    entityId: appointment._id,
    action: changed.status ? 'status_changed_by_doctor' : 'notes_changed_by_doctor',
    actor: 'doctor',
    before,
    after: { ...before, ...changed },
  });
  logger.info('Applied doctor edit from Sheet', { tokenNo, changed });
  return { tokenNo, applied: true, changed };
}

export async function pollSheetsInbound(deps = {}) {
  const {
    sheetsClient = getSheetsClient(),
    rebuildRowMap = rebuildRowMapImpl,
  } = deps;

  const response = await withRetry(
    () =>
      sheetsClient.spreadsheets.values.get({
        spreadsheetId: env.google.sheetId,
        range: SHEET_RANGE,
      }),
    { attempts: 3, context: { job: 'sheets-inbound-poll' } },
  );

  const rows = response?.data?.values || [];
  const map = {};
  for (let i = HEADER_ROW; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || !row[0]) continue;
    map[String(row[0])] = i + 1;
  }
  await rebuildRowMap(map);

  const results = [];
  for (const [tokenNo, rowIndex] of Object.entries(map)) {
    results.push(await applySheetEdit({ tokenNo, row: rows[rowIndex - 1] }));
  }
  return results;
}

export async function selfHealFailedSyncs({ enqueue = enqueueSheetSync, limit = 100 } = {}) {
  const failed = await Appointment.find({ sheetSyncStatus: 'failed' })
    .select('_id')
    .limit(limit)
    .lean();
  let reenqueued = 0;
  for (const appointment of failed) {
    try {
      await enqueue({ appointmentId: appointment._id });
      reenqueued += 1;
    } catch (err) {
      logger.error('Self-heal re-enqueue failed', {
        appointmentId: String(appointment._id),
        err: { message: err.message },
      });
    }
  }
  if (reenqueued > 0) logger.warn('Self-heal re-enqueued failed syncs', { reenqueued });
  return reenqueued;
}



export function startSheetsInboundPoll({ schedule = '* * * * *' } = {}) {
  return cron.schedule(schedule, () => {
    pollSheetsInbound().catch((err) => {
      logger.error('Sheets inbound poll failed', { err: { message: err.message } });
    });
  });
}

export function startSheetsSelfHeal({ schedule = '*/5 * * * *' } = {}) {
  return cron.schedule(schedule, () => {
    selfHealFailedSyncs().catch((err) => {
      logger.error('Sheets self-heal failed', { err: { message: err.message } });
    });
  });
}

export function startSheetsJobs() {
  const inboundPoll = startSheetsInboundPoll();
  const selfHeal = startSheetsSelfHeal();
  return {
    stop() {
      inboundPoll.stop();
      selfHeal.stop();
    },
  };
}
