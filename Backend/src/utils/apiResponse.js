/**
 * Standardized success response helper
 */
export const sendSuccess = (res, data = {}, message = '', statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    data,
    message
  });
};

/**
 * Standardized error response helper
 */
export const sendError = (res, message = 'Internal Server Error', error = null, statusCode = 500) => {
  return res.status(statusCode).json({
    success: false,
    message,
    ...(error ? { error: typeof error === 'object' && error.message ? error.message : error } : {})
  });
};
