import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchTargetByHint, resolveTargetAppointment } from '../../src/orchestrator/intents/target.appointment.js';

const A = { _id: '64a000000000000000000001', date: '2099-02-01', time: '10:00', tokenNo: 11 };
const B = { _id: '64a000000000000000000002', date: '2099-02-02', time: '11:00', tokenNo: 12 };
const upcoming = [A, B];

describe('target-appointment resolution (MEMORY.md §5)', () => {
  it('matches by targetAppointmentId hint', () => {
    assert.equal(matchTargetByHint(upcoming, { targetAppointmentId: A._id }), A);
  });

  it('matches by targetDate + targetTime hint', () => {
    assert.equal(matchTargetByHint(upcoming, { targetDate: '2099-02-02', targetTime: '11:00' }), B);
  });

  it('returns null when the hint points at a non-upcoming appointment', () => {
    assert.equal(matchTargetByHint(upcoming, { targetAppointmentId: '64a000000000000000000099' }), null);
    assert.equal(matchTargetByHint(upcoming, { targetDate: '2020-01-01', targetTime: '09:00' }), null);
  });

  it('returns null when there is no hint at all — caller must disambiguate', () => {
    assert.equal(matchTargetByHint(upcoming, {}), null);
    assert.equal(matchTargetByHint(upcoming, { targetDate: '2099-02-01' }), null, 'date without time is not a match');
  });

  it('prefers an already-chosen slot when it is still upcoming', () => {
    const conv = { slots: { targetAppointmentId: A._id } };
    assert.equal(resolveTargetAppointment(conv, upcoming, { targetDate: B.date, targetTime: B.time }), A);
  });

  it('falls back to the NLU hint when the chosen slot is no longer upcoming', () => {
    const conv = { slots: { targetAppointmentId: '64a000000000000000000099' } };
    assert.equal(resolveTargetAppointment(conv, upcoming, { targetDate: B.date, targetTime: B.time }), B);
  });

  it('returns null when nothing is chosen and no hint is usable', () => {
    assert.equal(resolveTargetAppointment({ slots: {} }, upcoming, {}), null);
  });
});
