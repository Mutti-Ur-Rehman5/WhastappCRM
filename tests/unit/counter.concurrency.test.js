import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, closeTestDb } from '../helpers/db.js';
import { Counter } from '../../src/models/Counter.model.js';
import { nextToken } from '../../src/utils/token.util.js';

before(async () => {
  await connectTestDb();
  // Start from a clean counter so the test is deterministic and re-runnable.
  await Counter.deleteOne({ _id: 'appointmentToken' });
});

after(async () => {
  await closeTestDb();
});

describe('nextToken() atomic counter', () => {
  it('100 concurrent calls yield exactly the integers 1..100 (no dupes, no gaps)', async () => {
    const results = await Promise.all(Array.from({ length: 100 }, () => nextToken()));

    assert.equal(results.length, 100, 'must return one token per call');
    assert.equal(new Set(results).size, 100, 'tokens must be unique');
    assert.deepEqual(
      [...results].sort((a, b) => a - b),
      Array.from({ length: 100 }, (_, i) => i + 1),
      'tokens must be sequential 1..100 with no gaps',
    );
  });

  it('increment inside an aborted transaction is rolled back', async () => {
    // Proves multi-document transactions work on the rs0 replica set — the
    // Phase 4 booking transaction depends on this exact behavior.
    const session = await mongoose.startSession();
    session.startTransaction();
    const seqInTx = await nextToken(session);
    await session.abortTransaction();
    session.endSession();

    const seqAfter = await nextToken();
    assert.equal(seqAfter, seqInTx, 'aborted increment must not persist');
  });
});
