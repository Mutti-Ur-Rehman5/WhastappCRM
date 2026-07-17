import { sendError } from '../utils/apiResponse.js';

export const errorMiddleware = (err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.url}:`, err);
  
  // Custom API Error handling
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  
  return sendError(res, message, err, statusCode);
};
