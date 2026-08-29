import { app } from './src/app.js';
import { env } from './src/config/env.js';
import { connectDb, disconnectDb } from './src/config/db.js';
import { redis, closeRedis } from './src/config/redis.js';
import { ensureAdminUser } from './src/services/passwordReset.service.js';
import { logger } from './src/utils/logger.js';

async function startServer() {
  await connectDb();
  await redis.ping();

  // Phase 11.5: seed/sync the admin credential from the DB so a password reset
  // survives restarts (the login controller keeps reading env.adminPasswordHash,
  // which this seeds from the persisted AdminUser row).
  await ensureAdminUser();

  // Bind 0.0.0.0 (all interfaces), not localhost: Cloudflare Tunnel needs to
  // reach this port over the loopback interface AND, if you ever run the stack
  // in Docker, the bridge network. Node would default to all interfaces anyway
  // when the host is omitted, but being explicit removes all ambiguity.
  const server = app.listen(env.port, '0.0.0.0', () => {
    logger.info(`Appointment Agent API listening on 0.0.0.0:${env.port} (all interfaces)`);
  });

  // ==========================================================================
  // TEMPORARY WORKAROUND: self-ping to prevent Render free-tier idle sleep.
  // Remove this once the app is on a paid Render plan (or equivalent) that
  // doesn't sleep on inactivity — an external uptime monitor is a more
  // reliable long-term alternative to this in-process ping.
  // ==========================================================================
  // Fully isolated: makes NO database/queue/WhatsApp calls, runs outside every
  // request handler, and is OFF by default — if SELF_PING_URL is unset nothing
  // here executes at all.
  const SELF_PING_INTERVAL_MS = 600_000; // every 10 min, safely under Render's 15-min idle cutoff
  const SELF_PING_TIMEOUT_MS = 8_000;

  function pingSelf() {
    if (!env.selfPingUrl) return;
    const target = env.selfPingUrl.endsWith('/health')
      ? env.selfPingUrl
      : `${env.selfPingUrl.replace(/\/$/, '')}/health`;
    fetch(target, { signal: AbortSignal.timeout(SELF_PING_TIMEOUT_MS) })
      .then((res) => {
        if (!res.ok) {
          logger.warn('Self-ping failed (non-2xx)', { target, status: res.status });
          return;
        }
        logger.debug('Self-ping ok', { target, status: res.status });
      })
      .catch((err) => logger.warn('Self-ping failed', { target, err: err.message }));
  }

  if (env.selfPingUrl) {
    pingSelf();
    const selfPingTimer = setInterval(pingSelf, SELF_PING_INTERVAL_MS);
    selfPingTimer.unref();
  }

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down gracefully`);
    server.close(async () => {
      await disconnectDb();
      await closeRedis();
      process.exit(0);
    });
    // Hard exit if graceful shutdown hangs (e.g. stuck connection).
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch((err) => {
  logger.error('Fatal startup error', { err: { message: err.message, stack: err.stack } });
  process.exit(1);
});
