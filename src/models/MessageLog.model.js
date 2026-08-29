import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

export const MESSAGE_DIRECTIONS = ['in', 'out'];
export const MESSAGE_CHANNELS = ['whatsapp', 'email'];

// Append-only raw message store (compliance/audit). Never trimmed — this is
// the long-term memory tier; Conversation.history is the trimmed LLM window.
export const messageLogSchema = new Schema(
  {
    phone: { type: String, required: true },
    direction: { type: String, enum: MESSAGE_DIRECTIONS, required: true },
    channel: { type: String, enum: MESSAGE_CHANNELS, default: 'whatsapp' },
    body: { type: String, required: true },
    // Meta may redeliver a webhook; unique index makes the dedupe check
    // race-safe at the DB level. Sparse because outbound emails have none.
    waMessageId: { type: String },
    // On reply records: the inbound waMessageId this reply answers. Lets the
    // idempotent worker tell "reply already sent" apart from "not yet", so a
    // retried job never sends a second reply (see inboundMessage.queue.js).
    refWaMessageId: { type: String },
  },
  { timestamps: { createdAt: 'ts', updatedAt: false } },
);

messageLogSchema.index({ waMessageId: 1 }, { unique: true, sparse: true });
messageLogSchema.index({ phone: 1, ts: -1 });

export const MessageLog = models.MessageLog || model('MessageLog', messageLogSchema);
