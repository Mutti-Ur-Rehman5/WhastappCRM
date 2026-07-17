import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Generate a short-lived access token (15 mins)
 */
export const generateAccessToken = (user) => {
  return jwt.sign(
    { id: user._id, name: user.name, email: user.email, role: user.role },
    env.JWT_SECRET,
    { expiresIn: '15m' }
  );
};

/**
 * Generate a long-lived refresh token (7 days)
 */
export const generateRefreshToken = (user) => {
  return jwt.sign(
    { id: user._id },
    env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
};

/**
 * Verify an access token
 */
export const verifyAccessToken = (token) => {
  return jwt.verify(token, env.JWT_SECRET);
};

/**
 * Verify a refresh token
 */
export const verifyRefreshToken = (token) => {
  return jwt.verify(token, env.JWT_REFRESH_SECRET);
};

/**
 * Cookie options for storing the refresh token securely
 */
export const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
};
