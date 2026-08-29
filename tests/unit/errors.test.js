import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BusinessError,
  SlotTakenError,
  LockUnavailableError,
  ValidationError,
} from '../../src/utils/errors.js';

describe('business error classes (RULES.md §4)', () => {
  it('SlotTakenError carries date/time and is a BusinessError', () => {
    const err = new SlotTakenError('2026-08-01', '17:00');
    assert.ok(err instanceof BusinessError);
    assert.ok(err instanceof Error);
    assert.equal(err.isBusinessError, true);
    assert.equal(err.code, 'SLOT_TAKEN');
    assert.equal(err.date, '2026-08-01');
    assert.equal(err.time, '17:00');
    assert.match(err.message, /2026-08-01 17:00/);
    assert.equal(err.name, 'SlotTakenError');
  });

  it('SlotTakenError preserves a cause (E11000 safety net)', () => {
    const cause = new Error('E11000 duplicate key');
    const err = new SlotTakenError('2026-08-01', '17:00', cause);
    assert.equal(err.cause, cause);
  });

  it('LockUnavailableError carries lockKey and is a BusinessError', () => {
    const err = new LockUnavailableError('lock:slot:a:b:c');
    assert.ok(err instanceof BusinessError);
    assert.equal(err.code, 'LOCK_UNAVAILABLE');
    assert.equal(err.lockKey, 'lock:slot:a:b:c');
    assert.match(err.message, /lock:slot:a:b:c/);
  });

  it('ValidationError is a BusinessError with a code', () => {
    const err = new ValidationError('bad input');
    assert.ok(err instanceof BusinessError);
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.message, 'bad input');
  });
});
