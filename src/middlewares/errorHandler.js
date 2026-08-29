import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';


export function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const isBusiness = err?.isBusinessError === true;
  const status = err?.status || err?.statusCode || (isBusiness ? 400 : 500);
  const isBodyParseError = err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large';

  if (isBusiness) {
    logger.warn('Business error rejected request', {
      requestId: req.id,
      code: err.code,
      message: err.message,
      status,
    });
    return res.status(status).json({ error: err.message, code: err.code });
  }

  if (status < 500) {
    logger.warn('Request rejected', { requestId: req.id, message: err.message, status });
    return res.status(status).json({ error: isBodyParseError ? 'Invalid request body' : err.message });
  }

  logger.error('Unhandled error', {
    requestId: req.id,
    err: { message: err.message, stack: err.stack },
  });
  const body = { error: 'Internal server error' };
  if (!env.isProduction) body.detail = err.message;
  return res.status(status).json(body);
}
