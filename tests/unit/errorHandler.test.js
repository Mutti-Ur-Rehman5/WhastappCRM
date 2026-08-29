import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  errorHandler,
  notFound,
  asyncHandler,
} from '../../src/middlewares/errorHandler.js';
import { BusinessError, SlotTakenError, ValidationError } from '../../src/utils/errors.js';

// Central error middleware (RULES.md §4, DESIGN.md §10): expected business
// errors → clean 4xx with a code; client 4xx → sanitized message; unexpected
// 5xx → generic body, full stack only server-side, never sent to the client.

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
  };
  return res;
}

describe('notFound', () => {
  it('replies 404 JSON for unmatched routes', () => {
    const res = mockRes();
    notFound({}, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Not found' });
  });
});

describe('errorHandler', () => {
  it('maps a BusinessError to a 4xx with its machine-readable code', () => {
    const res = mockRes();
    const err = new SlotTakenError('2026-08-05', '17:00');
    errorHandler(err, { id: 'req-1' }, res, () => assert.fail('next must not be called'));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'SLOT_TAKEN');
    assert.match(res.body.error, /Slot already taken/);
    assert.equal(res.body.stack, undefined, 'never serialize a stack to the client');
  });

  it('uses the error statusCode when a business error sets one', () => {
    const res = mockRes();
    const err = new ValidationError('bad input');
    err.statusCode = 422;
    errorHandler(err, { id: 'req-1' }, res, () => {});
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  });

  it('passes client 4xx errors through with a sanitized message', () => {
    const res = mockRes();
    const err = new Error('not allowed');
    err.status = 403;
    errorHandler(err, { id: 'req-1' }, res, () => {});
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'not allowed');
  });

  it('masks JSON body-parser errors with a clean message', () => {
    const res = mockRes();
    const err = new Error('Unexpected token } in JSON');
    err.type = 'entity.parse.failed';
    err.status = 400;
    errorHandler(err, { id: 'req-1' }, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Invalid request body');
  });

  it('maps unexpected errors to a generic 5xx and never leaks the stack', () => {
    const res = mockRes();
    const err = new Error('boom');
    err.stack = 'Error: boom\n  at internal:1:1';
    errorHandler(err, { id: 'req-1' }, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Internal server error');
    // Dev/test mode may include the message as detail — but the stack must
    // never be serialized, and production would omit detail entirely.
    assert.equal(res.body.detail, 'boom');
    assert.equal(res.body.stack, undefined);
  });

  it('forwards to next when headers are already sent', () => {
    let nextCalled = false;
    const res = mockRes();
    res.headersSent = true;
    errorHandler(new Error('late'), { id: 'req-1' }, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });
});

describe('asyncHandler', () => {
  it('forwards an async rejection to next (Express 4 does not do this)', async () => {
    const boom = new Error('async boom');
    const handler = asyncHandler(async () => {
      throw boom;
    });
    let nextErr = null;
    await handler({}, {}, (err) => {
      nextErr = err;
    });
    assert.equal(nextErr, boom);
  });

  it('lets successful async handlers respond normally', async () => {
    const handler = asyncHandler(async (req, res) => {
      res.json({ ok: true });
    });
    const res = mockRes();
    await handler({}, res, () => {});
    assert.deepEqual(res.body, { ok: true });
  });
});
