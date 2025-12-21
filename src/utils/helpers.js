const path = require('path');
const { ALLOWED_EXTENSIONS } = require('./constants');

/**
 * Generate unique filename with timestamp and random string
 */
function generateUniqueFilename(originalFilename) {
  const ext = path.extname(originalFilename);
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `${timestamp}-${random}${ext}`;
}

/**
 * Validate file extension
 */
function isValidFileExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}

/**
 * Format duration from seconds to human-readable string
 */
function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '0s';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

/**
 * Format file size to human-readable string
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Sanitize filename to prevent path traversal
 */
function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Calculate meeting duration from start and end time
 */
function calculateDuration(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  return Math.floor((new Date(endTime) - new Date(startTime)) / 1000);
}

/**
 * Extract error message from error object
 */
function getErrorMessage(error) {
  if (typeof error === 'string') return error;
  if (error.response && error.response.data && error.response.data.message) {
    return error.response.data.message;
  }
  if (error.message) return error.message;
  return 'Unknown error occurred';
}

module.exports = {
  generateUniqueFilename,
  isValidFileExtension,
  formatDuration,
  formatFileSize,
  sanitizeFilename,
  calculateDuration,
  getErrorMessage,
};
