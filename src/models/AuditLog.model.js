import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

export const AUDIT_ENTITIES = ['appointment', 'conversation', 'config'];
export const AUDIT_ACTORS = ['patient', 'doctor', 'system', 'admin'];

// Append-only compliance trail: every state-changing write (booking, cancel,
// reschedule, conversation transitions, doctor Sheet edits) produces a row.
export const auditLogSchema = new Schema(
  {
    entity: { type: String, enum: AUDIT_ENTITIES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, required: true },
    actor: { type: String, enum: AUDIT_ACTORS, required: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
  },
  // DESIGN.md §1.6 calls the timestamp field `ts`.
  { timestamps: { createdAt: 'ts', updatedAt: false } },
);

auditLogSchema.index({ entityId: 1, ts: 1 });
auditLogSchema.index({ actor: 1, ts: -1 });

export const AuditLog = models.AuditLog || model('AuditLog', auditLogSchema);
