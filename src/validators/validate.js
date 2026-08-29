import { ValidationError } from '../utils/errors.js';

// Shared helper for every admin endpoint (RULES.md §5 — treat all admin input
// as untrusted, not just patient WhatsApp text). A failed Joi check is raised
// as a ValidationError, which the central errorHandler maps to a clean 400 with
// code VALIDATION_ERROR. `stripUnknown: false` by default so body schemas with
// `.unknown(false)` actually REJECT (not silently strip) unapproved fields.

export function validateOrThrow(schema, data, options = {}) {
  const { error, value } = schema.validate(data, {
    abortEarly: false,
    convert: true,
    stripUnknown: false,
    ...options,
  });
  if (error) {
    throw new ValidationError(error.details.map((detail) => detail.message).join('; '));
  }
  return value;
}
