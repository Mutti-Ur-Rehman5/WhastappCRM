import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

// All states in the DESIGN.md §6 state machine.
export const CONVERSATION_STATES = [
  'IDLE',
  'COLLECTING_NAME',
  'COLLECTING_PHONE',
  'COLLECTING_REASON',
  'COLLECTING_DATETIME',
  'IDENTIFY_TARGET_APPOINTMENT',
  'COLLECTING_NEW_DATETIME',
  'AWAITING_CONFIRMATION',
];

export const PENDING_INTENTS = ['book', 'reschedule', 'cancel'];

export const conversationSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true },
    state: { type: String, enum: CONVERSATION_STATES, default: 'IDLE' },
    pendingIntent: { type: String, enum: PENDING_INTENTS, default: null },
    // Partially-filled slot-filling entities while the bot asks follow-ups.
    // `phone` is included per MEMORY.md §2 (usually pre-seeded from the sender
    // id; COLLECTING_PHONE only triggers when a different number is named).
    slots: {
      date: { type: String },
      time: { type: String },
      name: { type: String },
      phone: { type: String },
      reason: { type: String },
      targetAppointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment' },
    },
    lastMessageAt: { type: Date, default: Date.now },
    // Detected language/script of the patient's most recent message (see
    // localization.service.js): 'urdu' | 'sindhi' | 'pashto' | 'balochi' |
    // roman variants | 'english' | null. Kept on the conversation so short
    // follow-ups like "haan"/"yes" don't cause an unwanted language switch.
    language: { type: String, default: null },
    // Soft-archive instead of delete so late follow-ups can still be answered.
    archived: { type: Boolean, default: false },
    // Rolling context window (last 20 turns) fed to the LLM, trimmed on write.
    history: [
      {
        _id: false,
        role: { type: String, enum: ['user', 'assistant'], required: true },
        text: { type: String, required: true },
        ts: { type: Date, default: Date.now },
        meta: { type: Schema.Types.Mixed },
      },
    ],
  },
  { timestamps: true },
);

// Scanned by the timeout/cleanup cron (MEMORY.md §6).
conversationSchema.index({ lastMessageAt: 1 });

export const Conversation = models.Conversation || model('Conversation', conversationSchema);
