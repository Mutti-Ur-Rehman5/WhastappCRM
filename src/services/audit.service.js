import { AuditLog } from '../models/AuditLog.model.js';
import { MessageLog } from '../models/MessageLog.model.js';








const REQUIRED_FIELDS = ['entity', 'entityId', 'action', 'actor'];

export function assertValidAuditEntry(entry) {
  for (const field of REQUIRED_FIELDS) {
    if (entry[field] == null || entry[field] === '') {
      throw new Error(`audit entry missing required field: ${field}`);
    }
  }
}

export async function logAudit(entry, opts = {}) {
  assertValidAuditEntry(entry);
  const { session, ordered = false, model = AuditLog } = opts;
  return model.create([entry], { session, ordered });
}

export async function logAuditMany(entries, opts = {}) {
  if (entries.length === 0) return [];
  for (const entry of entries) assertValidAuditEntry(entry);
  const { session, ordered = false, model = AuditLog } = opts;
  return model.create(entries, { session, ordered });
}

export async function getAppointmentLifecycle({ appointmentId, patientPhone, limit = 500 } = {}) {
  const [auditRows, messageRows] = await Promise.all([
    AuditLog.find({ entity: 'appointment', entityId: appointmentId }).sort({ ts: 1 }).limit(limit).lean(),
    patientPhone
      ? MessageLog.find({ phone: patientPhone }).sort({ ts: 1 }).limit(limit).lean()
      : Promise.resolve([]),
  ]);

  const events = [
    ...auditRows.map((row) => ({
      type: 'audit',
      ts: row.ts,
      action: row.action,
      actor: row.actor,
      before: row.before,
      after: row.after,
    })),
    ...messageRows.map((row) => ({
      type: 'message',
      ts: row.ts,
      direction: row.direction,
      body: row.body,
      waMessageId: row.waMessageId,
      refWaMessageId: row.refWaMessageId,
    })),
  ].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  return {
    appointmentId,
    events,
    sources: { audit: auditRows.length, message: messageRows.length },
  };
}
