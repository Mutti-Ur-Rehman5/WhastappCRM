import { Router } from 'express';
import { register, login, refresh, logout, getMe, getUsers } from '../controllers/auth.controller.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { roleMiddleware } from '../middleware/role.middleware.js';

const router = Router();

// Registration endpoint with conditional authMiddleware for bootstrapping
router.post('/register', (req, res, next) => {
  if (req.headers.authorization) {
    return authMiddleware(req, res, next);
  }
  return next();
}, register);

router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', authMiddleware, getMe);
router.get('/users', authMiddleware, roleMiddleware('admin'), getUsers);

export default router;
