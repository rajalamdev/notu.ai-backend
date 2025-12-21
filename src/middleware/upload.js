const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config/env');
const { ALLOWED_MIME_TYPES, ALLOWED_EXTENSIONS } = require('../utils/constants');
const { sanitizeFilename, isValidFileExtension } = require('../utils/helpers');
const logger = require('../utils/logger');

// Ensure upload directory exists
if (!fs.existsSync(config.UPLOAD_DIR)) {
  fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
}

// Configure storage (temporary storage before uploading to MinIO)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'upload-' + uniqueSuffix + ext);
  },
});

// File filter
const fileFilter = (req, file, cb) => {
  const isValidMime = ALLOWED_MIME_TYPES.includes(file.mimetype);
  const isValidExt = isValidFileExtension(file.originalname);

  if (isValidMime && isValidExt) {
    cb(null, true);
  } else {
    logger.warn(`Invalid file upload attempt: ${file.originalname} (${file.mimetype})`);
    cb(
      new Error(
        `Invalid file type. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`
      ),
      false
    );
  }
};

// Multer configuration
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.MAX_FILE_SIZE,
  },
});

// Error handling middleware for multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: 'File too large',
        message: `Maximum file size is ${config.MAX_FILE_SIZE / (1024 * 1024)}MB`,
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        success: false,
        error: 'Unexpected file field',
        message: err.message,
      });
    }
    return res.status(400).json({
      success: false,
      error: 'File upload error',
      message: err.message,
    });
  }
  
  if (err) {
    return res.status(400).json({
      success: false,
      error: 'Invalid file',
      message: err.message,
    });
  }
  
  next();
};

module.exports = {
  upload,
  handleMulterError,
};
