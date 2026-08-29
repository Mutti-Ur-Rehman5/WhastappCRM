import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCircuitBreaker } from '../../src/utils/circuitBreaker.util.js';

// Phase 9 circuit breaker (DESIGN.md §10): fail-fast on the Gemini/Sheets
// upstreams. Fast thresholds keep the tests quick; the production defaults live
// in circuitBreaker.util.js.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isOpenError(err) {
  return err instanceof Error && (err.name === 'CircuitBreakerOpenError' || /open/i.test(err.message));
}

describe('createCircuitBreaker', () => {
  it('passes successful calls through and returns the value', async () => {
    const breaker = createCircuitBreaker('test', async (x) => x * 2, { volumeThreshold: 2 });
    assert.equal(await breaker.fire(21), 42);
    assert.equal(breaker.opened, false);
  });

  it('opens after volumeThreshold failures and then rejects fast (fn not called)', async () => {
    let calls = 0;
    const breaker = createCircuitBreaker(
      'test',
      async () => {
        calls += 1;
        throw new Error('upstream down');
      },
      { volumeThreshold: 2, errorThresholdPercentage: 99 },
    );

    await assert.rejects(breaker.fire(), /upstream down/);
    await assert.rejects(breaker.fire(), /upstream down/);
    assert.equal(breaker.opened, true, 'circuit opened after 2 consecutive failures');

    // Third fire while OPEN must reject immediately without invoking the fn.
    await assert.rejects(breaker.fire(), (err) => isOpenError(err));
    assert.equal(calls, 2, 'no call was made while the circuit was open');
  });

  it('half-opens after resetTimeout, probes, and closes on recovery', async () => {
    let calls = 0;
    const breaker = createCircuitBreaker(
      'test',
      async () => {
        calls += 1;
        if (calls <= 2) throw new Error('down');
        return 'recovered';
      },
      { volumeThreshold: 2, errorThresholdPercentage: 99, resetTimeout: 100 },
    );

    await assert.rejects(breaker.fire());
    await assert.rejects(breaker.fire());
    assert.equal(breaker.opened, true);

    await sleep(150); // past resetTimeout → half-open probe allowed

    assert.equal(await breaker.fire(), 'recovered');
    assert.equal(calls, 3, 'probe called the fn exactly once');
    assert.equal(breaker.opened, false, 'successful probe closed the circuit');
  });
});
