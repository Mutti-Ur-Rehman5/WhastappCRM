import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

// Atomic sequence generator. _id is the fixed key 'appointmentToken'; seq is
// incremented with findOneAndUpdate+$inc (DB-level atomic). Never derive a
// token via countDocuments()+1 — RULES.md forbids it as a race condition.
export const counterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export const Counter = models.Counter || model('Counter', counterSchema);
