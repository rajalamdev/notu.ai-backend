const rateLimit = require('express-rate-limit');
const config = require('../config/env');

/**
 * General API rate limiter
 */
const apiLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW * 60 * 1000, // Convert to milliseconds
  max: config.RATE_LIMIT_MAX_REQUESTS,
  message: {
    success: false,
    error: 'Too Many Requests',
    message: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Upload endpoint rate limiter (stricter)
 */
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 uploads per 15 minutes
  message: {
    success: false,
    error: 'Too Many Uploads',
    message: 'Upload limit exceeded. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  apiLimiter,
  uploadLimiter,
};
