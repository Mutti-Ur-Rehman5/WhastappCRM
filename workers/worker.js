import { connectDb } from '../src/config/db.js';
import { redis } from '../src/config/redis.js';
import { createInboundWorker } from '../src/queues/inboundMessage.queue.js';
import { enqueueSheetSync, createSheetsSyncWorker } from '../src/queues/sheetsSync.queue.js';
import {
  enqueueNotifyDoctor,
  createNotifyDoctorWorker,
} from '../src/queues/notifyDoctor.queue.js';
import {
  enqueueNotifyPatientConfirmation,
  createNotifyPatientWorker,
} from '../src/queues/notifyPatient.queue.js';
import {
  enqueueScheduleReminders,
  removeReminderJobs,
  createRemindersWorker,
} from '../src/queues/reminders.queue.js';
import {
  enqueueRescheduleTimeout,
  removeRescheduleTimeoutJob,
  createRescheduleTimeoutWorker,
} from '../src/queues/rescheduleTimeout.queue.js';
import { confirmReschedule, declineReschedule } from '../src/services/rescheduleConfirmation.service.js';
import { _setRescheduleDeps } from '../src/webhooks/whatsapp.webhook.js';
import { sendTextMessage } from '../src/services/whatsapp.service.js';
import { startSheetsJobs } from '../src/jobs/sheetsInboundPoll.job.js';
import { ensureSheetFormatting } from '../src/services/sheets.service.js';
import { logger } from '../src/utils/logger.js';

// Entrypoint for the separate worker process (scales independently of the API).
// This is the ONLY place the real enqueue fns are wired into the orchestrator:
// production booking happens inside this process, and every committed
// appointment then mirrors to Google Sheets and fires notifications/reminders
// via the async queues (RULES.md §9 — the booking service itself never calls
// the external APIs synchronously).
async function startWorker() {
  await connectDb();
  await redis.ping();

  // One-time Sheets formatting (DESIGN.md §7): styles the doctor-facing tab and
  // adds the Summary tab the first time the spreadsheet is seen. Best-effort —
  // a failure must not prevent the worker from serving messages, so it logs and
  // moves on (the Redis flag stays unset and a later restart retries).
  try {
    await ensureSheetFormatting();
  } catch (err) {
    logger.error('Sheets formatting failed (will retry next startup)', { err: { message: err.message } });
  }

  const inboundWorker = createInboundWorker({
    enqueueSheetSync,
    enqueueNotifyDoctor,
    enqueueNotifyPatientConfirmation,
    enqueueScheduleReminders,
    removeReminderJobs,
  });
  // Phase 12 — a patient's Yes/No button tap runs in this worker process, so
  // inject the REAL post-commit triggers (sheets mirror, doctor notify,
  // reminders, timeout-job removal) into the webhook's button-reply handler.
  const rescheduleQueues = {
    enqueueSheetSync,
    enqueueNotifyDoctor,
    enqueueScheduleReminders,
    removeReminderJobs,
    removeRescheduleTimeoutJob,
    sendTextMessage,
  };
  _setRescheduleDeps({
    confirmReschedule: (token, opts) => confirmReschedule(token, { ...rescheduleQueues, ...opts }),
    declineReschedule: (token, opts) => declineReschedule(token, { ...rescheduleQueues, ...opts }),
  });
  const sheetsWorker = createSheetsSyncWorker();
  const notifyDoctorWorker = createNotifyDoctorWorker();
  const notifyPatientWorker = createNotifyPatientWorker();
  const remindersWorker = createRemindersWorker();
  const rescheduleTimeoutWorker = createRescheduleTimeoutWorker({ enqueueRescheduleTimeout });
  const sheetsJobs = startSheetsJobs();
  logger.info(
    'Worker process started (inbound-message, sheets-sync, notify-doctor, notify-patient, reminders, reschedule-timeout consumers; sheets crons active)',
  );

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down worker`);
    await inboundWorker.close();
    await sheetsWorker.close();
    await notifyDoctorWorker.close();
    await notifyPatientWorker.close();
    await remindersWorker.close();
    await rescheduleTimeoutWorker.close();
    sheetsJobs.stop();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // BullMQ workers reject asynchronously on Redis/connection issues; an
  // unhandled rejection here would silently kill the process (or be swallowed),
  // leaving jobs enqueued-but-unprocessed. Log loudly instead of dying quietly.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection in worker process', {
      err: {
        message: reason?.message ?? String(reason),
        stack: reason?.stack,
      },
    });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception in worker process', {
      err: { message: err.message, stack: err.stack },
    });
  });
}

startWorker().catch((err) => {
  logger.error('Fatal worker startup error', { err: { message: err.message, stack: err.stack } });
  process.exit(1);
});
