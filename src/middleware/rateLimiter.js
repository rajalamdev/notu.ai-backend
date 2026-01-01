const rateLimit = require('express-rate-limit');
const config = require('../config/env');

/**
 * Skip rate limiting for authenticated users with valid tokens
 * This reduces rate limit issues for legitimate API usage
 */
const skipIfAuthenticated = (req) => {
  // If user is authenticated (has valid JWT), apply higher limits
  return req.user && req.user.id;
};

/**
 * General API rate limiter - stricter for unauthenticated requests
 */
const apiLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW * 60 * 1000, // Convert to milliseconds
  max: (req) => {
    // Authenticated users get 5x the limit
    if (req.user && req.user.id) {
      return config.RATE_LIMIT_MAX_REQUESTS * 5;
    }
    return config.RATE_LIMIT_MAX_REQUESTS;
  },
  message: {
    success: false,
    error: 'Too Many Requests',
    message: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Use user ID + IP as key for authenticated users to prevent shared IP issues
  keyGenerator: (req) => {
    if (req.user && req.user.id) {
      return `user_${req.user.id}`;
    }
    return req.ip;
  },
});

/**
 * Upload endpoint rate limiter (stricter)
 */
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: (req) => {
    // Authenticated users get higher upload limit
    if (req.user && req.user.id) {
      return 30; // 30 uploads per 15 minutes for auth users
    }
    return 10;
  },
  message: {
    success: false,
    error: 'Too Many Uploads',
    message: 'Upload limit exceeded. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (req.user && req.user.id) {
      return `upload_${req.user.id}`;
    }
    return req.ip;
  },
});

/**
 * Relaxed rate limiter for polling endpoints (status checks)
 */
const pollingLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute (1 per second)
  message: {
    success: false,
    error: 'Too Many Requests',
    message: 'Polling too frequently. Please slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  apiLimiter,
  uploadLimiter,
  pollingLimiter,
};
