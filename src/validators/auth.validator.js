import Joi from 'joi';

// Phase 11 admin dashboard login (RULES.md §5 — untrusted admin input).
// Deliberately permissive on length only; the actual credential check happens
// in the controller via bcrypt against ADMIN_PASSWORD_HASH.

export const loginSchema = Joi.object({
  username: Joi.string().trim().min(1).max(100).required(),
  password: Joi.string().min(1).max(200).required(),
}).unknown(false);
