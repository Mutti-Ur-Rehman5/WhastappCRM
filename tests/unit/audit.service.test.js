import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  logAudit,
  logAuditMany,
  assertValidAuditEntry,
} from '../../src/services/audit.service.js';

// The model is injectable so these run DB-free and fast (CI). A fake model
// records exactly what logAudit/logAuditMany pass through — the contract the
// real AuditLog model (covered by models.test.js + the integration suite)
// must fulfill.
function fakeModel() {
  const calls = [];
  return {
    calls,
    async create(docs, opts) {
      calls.push({ docs, opts });
      return docs.map((d) => ({ ...d, _id: 'a1', ts: new Date() }));
    },
  };
}

const validEntry = () => ({
  entity: 'appointment',
  entityId: 'appt-1',
  action: 'booked',
  actor: 'patient',
  after: { status: 'confirmed' },
});

describe('audit.service (unit, mocked model)', () => {
  it('logAudit writes the entry through the model with the caller session/ordered options', async () => {
    const model = fakeModel();
    const session = { id: 'txn-1' };
    const [doc] = await logAudit(validEntry(), { session, model });

    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0].docs.length, 1);
    assert.deepEqual(model.calls[0].docs[0], validEntry());
    assert.equal(model.calls[0].opts.session, session);
    assert.equal(doc._id, 'a1');
  });

  it('logAuditMany writes the whole batch in one create call', async () => {
    const model = fakeModel();
    const entries = [validEntry(), { ...validEntry(), action: 'cancelled', actor: 'system' }];
    const docs = await logAuditMany(entries, { session: {}, ordered: true, model });

    assert.equal(model.calls.length, 1);
    assert.deepEqual(model.calls[0].docs, entries);
    assert.equal(model.calls[0].opts.ordered, true);
    assert.equal(docs.length, 2);
  });

  it('logAuditMany returns [] for an empty batch without touching the model', async () => {
    const model = fakeModel();
    const docs = await logAuditMany([], { model });

    assert.deepEqual(docs, []);
    assert.equal(model.calls.length, 0);
  });

  it('logAudit rejects an entry missing a required field (before writing)', async () => {
    const model = fakeModel();
    await assert.rejects(
      logAudit({ entity: 'appointment', entityId: 'x', action: 'booked' }, { model }),
      /actor/,
    );
    await assert.rejects(
      logAudit({ entity: 'appointment', actor: 'patient', action: 'booked' }, { model }),
      /entityId/,
    );
    assert.equal(model.calls.length, 0);
  });

  it('logAuditMany rejects a malformed batch before writing anything', async () => {
    const model = fakeModel();
    await assert.rejects(
      logAuditMany([validEntry(), { entity: 'appointment', action: 'x', actor: 'doctor' }], { model }),
      /entityId/,
    );
    assert.equal(model.calls.length, 0);
  });

  it('assertValidAuditEntry accepts a fully-formed entry', () => {
    assert.doesNotThrow(() => assertValidAuditEntry(validEntry()));
  });
});
