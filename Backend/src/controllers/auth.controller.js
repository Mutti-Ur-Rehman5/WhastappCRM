import User from '../models/User.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  REFRESH_COOKIE_OPTIONS
} from '../utils/jwt.js';

/**
 * Register a new user.
 * Allows bootstrapping the first user as 'admin' automatically.
 * Subsequent registrations require an admin token.
 */
export const register = async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      return sendError(res, 'Name, email, and password are required', null, 400);
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return sendError(res, 'User with this email already exists', null, 400);
    }

    const userCount = await User.countDocuments();
    const isFirstUser = userCount === 0;

    // If not the first user, check for admin privileges
    if (!isFirstUser) {
      if (!req.user || req.user.role !== 'admin') {
        return sendError(res, 'Only administrator accounts can register new users', null, 403);
      }
    }

    const finalRole = isFirstUser ? 'admin' : (role || 'agent');

    const newUser = await User.create({
      name,
      email,
      password,
      role: finalRole
    });

    const userObj = {
      id: newUser._id,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role
    };

    return sendSuccess(res, { user: userObj }, 'User registered successfully', 201);
  } catch (error) {
    return next(error);
  }
};

/**
 * Login user and issue tokens
 */
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return sendError(res, 'Email and password are required', null, 400);
    }

    const user = await User.findOne({ email });
    if (!user) {
      return sendError(res, 'Invalid email or password', null, 401);
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return sendError(res, 'Invalid email or password', null, 401);
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // Set refresh token in HTTP-only cookie
    res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

    const userObj = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role
    };

    return sendSuccess(res, { accessToken, user: userObj }, 'Login successful');
  } catch (error) {
    return next(error);
  }
};

/**
 * Refresh access token using the HTTP-only refresh token cookie
 */
export const refresh = async (req, res, next) => {
  try {
    const cookies = req.headers.cookie;
    let refreshToken = null;

    if (cookies) {
      const parsedCookies = cookies.split(';').reduce((acc, cookieStr) => {
        const parts = cookieStr.split('=');
        acc[parts[0].trim()] = (parts[1] || '').trim();
        return acc;
      }, {});
      refreshToken = parsedCookies['refreshToken'];
    }

    if (!refreshToken) {
      return sendError(res, 'Refresh token not found', null, 401);
    }

    const decoded = verifyRefreshToken(refreshToken);
    const user = await User.findById(decoded.id);

    if (!user) {
      return sendError(res, 'User not found', null, 401);
    }

    const accessToken = generateAccessToken(user);
    return sendSuccess(res, { accessToken }, 'Token refreshed successfully');
  } catch (error) {
    return sendError(res, 'Invalid refresh token', error, 401);
  }
};

/**
 * Logout user by clearing the refresh token cookie
 */
export const logout = async (req, res, next) => {
  try {
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    return sendSuccess(res, {}, 'Logged out successfully');
  } catch (error) {
    return next(error);
  }
};

/**
 * Retrieve current user profile
 */
export const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return sendError(res, 'User not found', null, 404);
    }
    return sendSuccess(res, { user }, 'User retrieved successfully');
  } catch (error) {
    return next(error);
  }
};

/**
 * List all users in the system (Admin only)
 */
export const getUsers = async (req, res, next) => {
  try {
    const users = await User.find().select('-password');
    return sendSuccess(res, { users }, 'Users retrieved successfully');
  } catch (error) {
    return next(error);
  }
};
