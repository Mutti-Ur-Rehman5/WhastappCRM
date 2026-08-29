import { logger } from './logger.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry(fn, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 200,
    factor = 2,
    maxDelayMs = 10000,
    jitterMs = 50,
    shouldRetry = () => true,
    context = {},
  } = options;

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !shouldRetry(err, attempt)) throw err;
      const delay = Math.min(baseDelayMs * factor ** (attempt - 1), maxDelayMs) + Math.random() * jitterMs;
      logger.warn(`Retryable call failed (attempt ${attempt}/${attempts}), retrying in ${Math.round(delay)}ms`, {
        ...context,
        err: { message: err.message, code: err.code, status: err.response?.status },
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}
