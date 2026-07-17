import { sendError } from '../utils/apiResponse.js';

export const roleMiddleware = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return sendError(res, 'Unauthorized. Please authenticate first.', null, 401);
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      return sendError(res, 'Forbidden. Insufficient permissions.', null, 403);
    }
    
    return next();
  };
};
