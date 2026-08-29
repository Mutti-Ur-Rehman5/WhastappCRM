import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { signAdminSession, adminCookieOptions } from '../utils/session.util.js';
import { validateOrThrow } from '../validators/validate.js';
import { loginSchema } from '../validators/auth.validator.js';
import { logger } from '../utils/logger.js';






export async function login(req, res) {
  const { username, password } = validateOrThrow(loginSchema, req.body);

  if (!env.adminPasswordHash) {
    return res.status(503).json({ error: 'Admin login not configured', code: 'ADMIN_LOGIN_NOT_CONFIGURED' });
  }

  let passwordOk = false;
  try {
    passwordOk = await bcrypt.compare(password, env.adminPasswordHash);
  } catch {


    passwordOk = false;
  }
  if (username !== env.adminUsername || !passwordOk) {
    logger.warn('Admin login rejected', { requestId: req.id });
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = signAdminSession({ username });
  res.cookie(env.adminSessionCookieName, token, adminCookieOptions());
  logger.info('Admin logged in', { username, requestId: req.id });
  res.json({ ok: true, username });
}


export function logout(req, res) {
  res.clearCookie(env.adminSessionCookieName, adminCookieOptions());
  res.json({ ok: true });
}

export function me(req, res) {
  res.json({ username: req.admin?.username || env.adminUsername });
}
