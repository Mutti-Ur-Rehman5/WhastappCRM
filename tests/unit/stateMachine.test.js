import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTransition,
  BOOK_FIELD_STATES,
  computeNextState,
  missingBookingFields,
  nextStateForBook,
} from '../../src/orchestrator/stateMachine.js';

const conv = (state, slots = {}) => ({ state, slots });

describe('missingBookingFields', () => {
  it('reports everything missing from an empty slot set', () => {
    assert.deepEqual(missingBookingFields({}), ['name', 'reason']);
  });

  it('treats date-only as datetime still missing (name + reason are the only required fields)', () => {
    assert.deepEqual(missingBookingFields({ date: '2026-08-02' }), ['name', 'reason']);
  });

  it('never asks for the phone — it is always the sender id', () => {
    assert.ok(!missingBookingFields({}).includes('phone'));
    assert.ok(!missingBookingFields({}).includes('phone'));
  });
});

describe('nextStateForBook (DESIGN.md §6 book chain)', () => {
  it('starts at COLLECTING_NAME with no fields', () => {
    assert.equal(nextStateForBook({}), 'COLLECTING_NAME');
  });

  it('walks COLLECTING_NAME → COLLECTING_REASON → AWAITING_CONFIRMATION as fields fill (datetime auto-assigned)', () => {
    assert.equal(nextStateForBook({ name: 'Ahmed' }), 'COLLECTING_REASON');
    assert.equal(nextStateForBook({ name: 'Ahmed', reason: 'fever' }), 'AWAITING_CONFIRMATION');
  });

  it('jumps straight to AWAITING_CONFIRMATION when all fields are present', () => {
    const all = { name: 'Ahmed', phone: '+923001234567', reason: 'fever', date: '2026-08-02', time: '17:00' };
    assert.equal(nextStateForBook(all), 'AWAITING_CONFIRMATION');
  });

  it('maps each missing field to its DESIGN state', () => {
    assert.equal(BOOK_FIELD_STATES.name, 'COLLECTING_NAME');
    assert.equal(BOOK_FIELD_STATES.phone, 'COLLECTING_PHONE');
    assert.equal(BOOK_FIELD_STATES.reason, 'COLLECTING_REASON');
    assert.equal(BOOK_FIELD_STATES.datetime, undefined);
  });
});

describe('computeNextState (DESIGN.md §6 transition table)', () => {
  it('IDLE + book intent (missing fields) → first collecting state', () => {
    assert.equal(computeNextState(conv('IDLE'), { intent: 'book', slots: {} }), 'COLLECTING_NAME');
  });

  it('IDLE + book intent (all fields) → AWAITING_CONFIRMATION', () => {
    const slots = { name: 'Ahmed', phone: '+923001234567', reason: 'fever', date: '2026-08-02', time: '17:00' };
    assert.equal(computeNextState(conv('IDLE'), { intent: 'book', slots }), 'AWAITING_CONFIRMATION');
  });

  it('AWAITING_CONFIRMATION + confirm true → IDLE', () => {
    assert.equal(computeNextState(conv('AWAITING_CONFIRMATION'), { intent: 'confirm', confirm: true }), 'IDLE');
  });

  it('AWAITING_CONFIRMATION + confirm false → IDLE', () => {
    assert.equal(computeNextState(conv('AWAITING_CONFIRMATION'), { intent: 'confirm', confirm: false }), 'IDLE');
  });

  it('confirm while NOT awaiting confirmation is ignored (state stays)', () => {
    assert.equal(computeNextState(conv('COLLECTING_NAME'), { intent: 'confirm' }), 'COLLECTING_NAME');
  });

  it('query intent answers directly without state change', () => {
    assert.equal(computeNextState(conv('IDLE'), { intent: 'query' }), 'IDLE');
  });

  it('smalltalk/unclear keeps the current in-flight state', () => {
    assert.equal(computeNextState(conv('COLLECTING_REASON'), { intent: 'smalltalk' }), 'COLLECTING_REASON');
    assert.equal(computeNextState(conv('COLLECTING_REASON'), { intent: 'unclear' }), 'COLLECTING_REASON');
  });

  it('reschedule branch: IDLE → IDENTIFY_TARGET_APPOINTMENT → COLLECTING_NEW_DATETIME (Phase 5 wires it)', () => {
    assert.equal(computeNextState(conv('IDLE'), { intent: 'reschedule' }), 'IDENTIFY_TARGET_APPOINTMENT');
    assert.equal(
      computeNextState(conv('IDENTIFY_TARGET_APPOINTMENT'), { intent: 'reschedule' }),
      'COLLECTING_NEW_DATETIME',
    );
  });

  it('cancel branch: IDLE → IDENTIFY_TARGET_APPOINTMENT', () => {
    assert.equal(computeNextState(conv('IDLE'), { intent: 'cancel' }), 'IDENTIFY_TARGET_APPOINTMENT');
  });
});

describe('applyTransition', () => {
  it('mutates state and returns before/after for the AuditLog', () => {
    const c = conv('IDLE');
    const record = applyTransition(c, 'COLLECTING_NAME', { actor: 'patient' });
    assert.deepEqual(record, { before: 'IDLE', after: 'COLLECTING_NAME', actor: 'patient' });
    assert.equal(c.state, 'COLLECTING_NAME');
  });

  it('returns null when the state does not actually change (no audit row)', () => {
    const c = conv('IDLE');
    assert.equal(applyTransition(c, 'IDLE'), null);
    assert.equal(c.state, 'IDLE');
  });

  it('rejects an unknown state', () => {
    assert.throws(() => applyTransition(conv('IDLE'), 'NOT_A_STATE'), /Unknown conversation state/);
  });
});
