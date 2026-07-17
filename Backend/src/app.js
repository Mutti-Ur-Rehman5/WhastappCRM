import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import { errorMiddleware } from './middleware/error.middleware.js';

const app = express();

// Configure CORS
app.use(cors({
  origin: env.CLIENT_URL,
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Base API Routes
app.use('/api', healthRoutes);
app.use('/api/auth', authRoutes);

// Global Error Handler
app.use(errorMiddleware);

export default app;
