import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.util.js';







let transport = null;

export function getEmailTransport(transportFactory) {
  if (!transport) {
    transport = transportFactory
      ? transportFactory()
      : nodemailer.createTransport({
          host: env.smtp.host,
          port: env.smtp.port,
          secure: env.smtp.port === 465,
          auth: { user: env.smtp.user, pass: env.smtp.pass },
        });
  }
  return transport;
}

export async function closeEmailTransport() {
  if (transport) {
    await transport.close();
    transport = null;
  }
}

export async function sendEmail({ to, subject, text, from, transport: t = getEmailTransport() }) {
  if (!to) throw new Error('sendEmail requires a recipient');
  const info = await withRetry(
    () =>
      t.sendMail({
        from: from || `"Clinic Assistant" <${env.smtp.user}>`,
        to,
        subject,
        text,
      }),
    {
      attempts: 3,
      baseDelayMs: 200,
      shouldRetry: () => true,
      context: { to, subject },
    },
  );
  logger.info('Email sent', { to, subject, messageId: info?.messageId });
  return info;
}

export async function sendDoctorNotificationEmail({ to, subject, text, transport }) {
  return sendEmail({ to: to || env.doctorEmail, subject, text, transport });
}
