// Manual WhatsApp smoke test — sends ONE real message to verify the real Cloud
// API send path end-to-end (real token, phone number ID, API version).
//
//   node --env-file=.env scripts/smokeWhatsApp.js +923001234567 "Hello from the agent"
//
// The recipient must be a WhatsApp number that is allowed to receive from your
// Meta app. Right after onboarding, Meta only lets you message the test number
// registered in the WhatsApp dashboard (typically your own phone), and only a
// 24h window after an inbound message OR via approved templates. If you get an
// error like "message undeliverable / re-engage" you must first send a message
// FROM that phone TO your WhatsApp Business number to open the window.
import { sendTextMessage } from '../src/services/whatsapp.service.js';

const [to, ...rest] = process.argv.slice(2);
const text = rest.join(' ') || 'Hello from the appointment agent — WhatsApp send path works!';

if (!to) {
  console.error('Usage: node --env-file=.env scripts/smokeWhatsApp.js <recipient-phone> [message]');
  console.error('Example: node --env-file=.env scripts/smokeWhatsApp.js +923001234567 "Hello"');
  process.exit(1);
}

try {
  const messageId = await sendTextMessage({ to, text });
  if (!messageId) {
    console.error('No message id returned — check the Graph API response shape.');
    process.exit(1);
  }
  console.log(`WhatsApp message sent OK. Message id: ${messageId}`);
  console.log(`Check ${to} for the message: "${text}"`);
} catch (err) {
  console.error('WhatsApp send FAILED:', err.message);
  if (err.response?.data?.error) {
    console.error('Meta API error:', JSON.stringify(err.response.data.error, null, 2));
  }
  process.exit(1);
}
