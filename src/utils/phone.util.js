const E164_REGEX = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('Phone number is empty');
  const cleaned = raw.trim().replace(/[^\d+]/g, '');
  const phone = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  if (!E164_REGEX.test(phone)) throw new Error(`Invalid phone number: ${raw}`);
  return phone;
}
