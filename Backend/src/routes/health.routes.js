import { Router } from 'express';
import mongoose from 'mongoose';
import { sendSuccess } from '../utils/apiResponse.js';

const router = Router();

router.get('/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  let dbStatus = 'Disconnected';
  
  if (dbState === 1) dbStatus = 'Connected';
  else if (dbState === 2) dbStatus = 'Connecting';
  else if (dbState === 3) dbStatus = 'Disconnecting';
  
  return sendSuccess(res, {
    status: 'healthy',
    dbStatus,
    timestamp: new Date()
  }, 'Server is running smoothly');
});

export default router;
