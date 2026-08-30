import path from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { router } from './routes/index.js';
import { requestLogger } from './middlewares/requestLogger.js';
import { notFound, errorHandler } from './middlewares/errorHandler.js';
import { logger } from './utils/logger.js';

export const app = express();

app.disable('x-powered-by');
// Behind the Cloudflare quick-tunnel exactly ONE reverse proxy (cloudflared)
// sets X-Forwarded-For, so express-rate-limit trusts a single hop. `true`
// would be permissive (any client could spoof the IP) and express-rate-limit
// refuses it with ERR_ERL_PERMISSIVE_TRUST_PROXY.
app.set('trust proxy', 1);

// The admin dashboard is hosted separately (Vercel) while the API stays on
// Render/Express, so cross-origin requests must be allowed. Allowed origins
// come from FRONTEND_URL (single frontend origin) and/or CORS_ALLOWED_ORIGINS
// (comma-separated extra origins). On a matching Origin we echo it back with
// credentials and answer preflights; anything else behaves as same-origin
// (and webhook signature checks are unchanged). Registered at the very top so
// EVERY response (even body-parse errors) carries the CORS headers.
const allowedOrigins = new Set(
  [
    env.frontendUrl,
    ...(env.corsAllowedOrigins || '').split(',').map((s) => s.trim()).filter(Boolean),
  ].filter(Boolean),
);
if (allowedOrigins.size > 0) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-admin-api-key, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });
}

app.use(helmet());
// `verify` captures the exact raw bytes for webhook HMAC verification —
// re-serializing the parsed JSON would break the signature check.
app.use(
  express.json({
    limit: '1mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
// Phase 11: httpOnly admin session cookies (requireAdminSession in adminAuth).
app.use(cookieParser());
app.use(requestLogger);
// Phase 8: every HTTP access log carries the correlation id (`X-Request-Id`
// set by requestLogger) so a request is traceable from ingress to the queue
// jobs it spawns. `combined` (prod) / `dev` (local) + the request id suffix.
const httpLogFormat = `${env.isProduction ? 'combined' : ':method :url :status :response-time ms - :res[content-length]'} req-id=:req[x-request-id]`;
app.use(
  morgan(httpLogFormat, {
    stream: { write: (message) => logger.http(message.trim()) },
  }),
);

app.use(router);

// Phase 11: serve the built React admin dashboard at /admin (same Express
// server, per the dashboard spec). Mounted AFTER the API router so /api/* can
// never be shadowed, and only when a build exists (tests/dev boot without one).
const adminDist = fileURLToPath(new URL('../admin/dist', import.meta.url));
if (existsSync(path.join(adminDist, 'index.html'))) {
  app.use('/admin', express.static(adminDist));
  // Relative asset base (vite base './') resolves correctly from /admin/
  // (with trailing slash). Redirect the bare /admin there so assets load.
  app.get('/admin', (req, res) => res.redirect(301, '/admin/'));
  app.get('/admin/*', (req, res) => res.sendFile(path.join(adminDist, 'index.html')));
} else {
  logger.warn('Admin dashboard build not found — /admin disabled (build admin/ first)');
}

app.use(notFound);
app.use(errorHandler);
