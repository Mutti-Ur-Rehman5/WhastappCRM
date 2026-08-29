import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { env } from '../../src/config/env.js';
import { verifyWebhookSignature } from '../../src/middlewares/verifyWebhookSignature.js';

const secret = env.whatsapp.appSecret;
const sign = (body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

function makeReqRes({ header, rawBody }) {
  const res = {
    statusCode: null,
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
  };
  const req = {
    id: 'req-test',
    get(name) {
      return name.toLowerCase() === 'x-hub-signature-256' ? header : undefined;
    },
    rawBody,
  };
  return { req, res };
}

describe('verifyWebhookSignature', () => {
  it('passes a valid signature', () => {
    const rawBody = Buffer.from('{"hello":"world"}');
    const { req, res } = makeReqRes({ header: sign(rawBody), rawBody });
    let nextCalled = false;
    verifyWebhookSignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  });

  it('rejects a request with no signature header', () => {
    const { req, res } = makeReqRes({ header: undefined, rawBody: Buffer.from('{}') });
    let nextCalled = false;
    verifyWebhookSignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('rejects a malformed signature header', () => {
    const { req, res } = makeReqRes({ header: 'sha256=nothex', rawBody: Buffer.from('{}') });
    let nextCalled = false;
    verifyWebhookSignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('rejects a signature computed over a different body', () => {
    const bodyA = Buffer.from('{"msg":"original"}');
    const { req, res } = makeReqRes({ header: sign(bodyA), rawBody: Buffer.from('{"msg":"tampered"}') });
    let nextCalled = false;
    verifyWebhookSignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const rawBody = Buffer.from('{"hello":"world"}');
    const wrong = `sha256=${crypto.createHmac('sha256', 'some-other-secret').update(rawBody).digest('hex')}`;
    const { req, res } = makeReqRes({ header: wrong, rawBody });
    let nextCalled = false;
    verifyWebhookSignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('is case-insensitive on the header value', () => {
    const rawBody = Buffer.from('{"hello":"world"}');
    const upper = `SHA256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const { req, res } = makeReqRes({ header: upper, rawBody });
    let nextCalled = false;
    verifyWebhookSignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});
