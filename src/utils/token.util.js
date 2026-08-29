import { Counter } from '../models/Counter.model.js';

// Atomic, race-safe token generator per DESIGN.md §1.6. Pass a mongoose
// session when called inside a booking transaction so the increment commits
// with (or rolls back with) the appointment insert.
export async function nextToken(session) {
  const options = { upsert: true, new: true };
  if (session) options.session = session;

  const doc = await Counter.findOneAndUpdate(
    { _id: 'appointmentToken' },
    { $inc: { seq: 1 } },
    options,
  );
  return doc.seq;
}
