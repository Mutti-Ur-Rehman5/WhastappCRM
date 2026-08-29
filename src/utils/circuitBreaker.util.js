import CircuitBreaker from 'opossum';
import { logger } from './logger.js';








export const DEFAULT_BREAKER_OPTIONS = {
  timeout: 45_000,


  resetTimeout: 30_000,




  errorThresholdPercentage: 99,
  volumeThreshold: 5,
  rollingCountTimeout: 10_000,
  enableSnapshots: false,
};

export function createCircuitBreaker(name, fn, options = {}) {
  const breaker = new CircuitBreaker(fn, { ...DEFAULT_BREAKER_OPTIONS, ...options });

  breaker.on('open', () => logger.warn(`Circuit breaker ${name}: closed -> open`, { breaker: name }));
  breaker.on('halfOpen', () =>
    logger.warn(`Circuit breaker ${name}: open -> half-open (probe allowed)`, { breaker: name }),
  );
  breaker.on('close', () => logger.warn(`Circuit breaker ${name}: half-open -> closed`, { breaker: name }));
  breaker.on('reject', (err) =>
    logger.warn(`Circuit breaker ${name}: request rejected while open`, { breaker: name, err: err?.message }),
  );

  return breaker;
}
