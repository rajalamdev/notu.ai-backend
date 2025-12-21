require('dotenv').config();

/**
 * Parse MinIO configuration from environment variables
 * Supports both Docker (minio:9000) and local (localhost:9000) environments
 */
function parseMinioConfig() {
  const endpoint = process.env.AWS_ENDPOINT || 'http://localhost:9000';
  
  try {
    const url = new URL(endpoint);
    return {
      endPoint: url.hostname,
      port: parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 9000),
      useSSL: url.protocol === 'https:',
      accessKey: process.env.AWS_ACCESS_KEY_ID || 'minioadmin',
      secretKey: process.env.AWS_SECRET_ACCESS_KEY || 'minioadmin',
      bucket: process.env.AWS_S3_BUCKET || 'notu-recordings',
    };
  } catch (error) {
    // Fallback to localhost if URL parsing fails
    return {
      endPoint: 'localhost',
      port: 9000,
      useSSL: false,
      accessKey: process.env.AWS_ACCESS_KEY_ID || 'minioadmin',
      secretKey: process.env.AWS_SECRET_ACCESS_KEY || 'minioadmin',
      bucket: process.env.AWS_S3_BUCKET || 'notu-recordings',
    };
  }
}

module.exports = {
  // Server
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 4000,

  // MongoDB
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/notu-db',

  // Redis
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  // MinIO (S3) - Dynamic configuration
  MINIO: parseMinioConfig(),

  // WhisperX
  WHISPERX_API_URL: process.env.WHISPERX_API_URL || 'http://localhost:5005',

  // Bot Service
  BOT_SERVICE_URL: process.env.BOT_SERVICE_URL || 'http://localhost:3001',

  // Upload
  UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE, 10) || 104857600, // 100MB

  // Security
  RATE_LIMIT_WINDOW: parseInt(process.env.RATE_LIMIT_WINDOW, 10) || 15,
  RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,

  // CORS
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // JWT Authentication
  JWT_SECRET: process.env.JWT_SECRET || 'notu-ai-secret-key-change-in-production',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',

  // Google OAuth (for verification)
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
};
