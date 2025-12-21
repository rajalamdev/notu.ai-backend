const express = require('express');
const { upload, handleMulterError } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { validate, schemas } = require('../middleware/validator');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { uploadMeeting } = require('../controllers/uploadController');

const router = express.Router();

/**
 * POST /api/upload
 * Upload audio/video file for transcription
 * Requires authentication
 */
router.post(
  '/',
  authenticate,
  uploadLimiter,
  upload.single('file'),
  handleMulterError,
  validate(schemas.uploadMeeting),
  asyncHandler(uploadMeeting)
);

module.exports = router;
