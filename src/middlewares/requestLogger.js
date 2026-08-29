import { randomUUID } from 'node:crypto';

// Assigns a correlation id per request, echoed back in the response header (and
// mirrored onto req.headers so morgan's `:req[x-request-id]` access log picks it
// up) — logs from one HTTP request and the queue jobs it spawns share the id.
export function requestLogger(req, res, next) {
  req.id = req.id || randomUUID();
  req.headers['x-request-id'] = req.id;
  res.setHeader('X-Request-Id', req.id);
  next();
}
