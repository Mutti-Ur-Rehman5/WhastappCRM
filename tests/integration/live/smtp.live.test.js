// LIVE SMTP check (RULES.md §7): sends ONE real email through the configured
// SMTP relay and asserts nodemailer got a messageId — proving the SMTP creds
// work before Phase 7 builds doctor notifications on top of them.
//
// Excluded from the default `npm test` glob (tests/integration/live/). Run it
// explicitly with the real .env:
//
//   $env:RUN_LIVE_TESTS='true'; node --env-file=.env --test "tests/integration/live/*.test.js"
//
// Requires DOCTOR_EMAIL to be set in .env (the recipient).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { env } from '../../../src/config/env.js';

const runLive = process.env.RUN_LIVE_TESTS === 'true';

test(
  'live SMTP: sends one real email and gets a messageId',
  { skip: runLive ? false : 'set RUN_LIVE_TESTS=true and run with the real .env' },
  async () => {
    assert.ok(env.doctorEmail, 'DOCTOR_EMAIL must be set in .env for the live SMTP test');

    const { host, port, user, pass } = env.smtp;
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    try {
      const info = await transport.sendMail({
        from: `"Appointment Agent" <${user}>`,
        to: env.doctorEmail,
        subject: 'Appointment Agent — SMTP live test',
        text: 'This is a live SMTP test message from the appointment agent. If you are reading this, the SMTP credentials work.',
      });
      assert.ok(info.messageId, 'nodemailer did not return a messageId');
      console.log(`SMTP OK — email sent to ${env.doctorEmail}, messageId=${info.messageId}`);
    } finally {
      transport.close();
    }
  },
);
