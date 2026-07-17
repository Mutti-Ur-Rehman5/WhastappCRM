import { verifyAccessToken } from '../utils/jwt.js';
import { sendError } from '../utils/apiResponse.js';

export const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendError(res, 'Access denied. No token provided.', null, 401);
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);
    
    req.user = decoded; // Attach payload containing id, name, email, role
    return next();
  } catch (error) {
    let message = 'Invalid or expired token.';
    if (error.name === 'TokenExpiredError') {
      message = 'Access token expired.';
    }
    return sendError(res, message, error, 401);
  }
};
