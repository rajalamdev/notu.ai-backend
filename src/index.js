const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const config = require('./config/env');
const { connectDatabase } = require('./config/database');
const { createRedisClient } = require('./config/redis');
const { ensureBucket } = require('./config/minio');
const { createTranscriptionQueue } = require('./services/queueService');
const { startTranscriptionWorker } = require('./workers/transcriptionWorker');
const { apiLimiter } = require('./middleware/rateLimiter');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const routes = require('./routes');
const logger = require('./utils/logger');

// Create Express app
const app = express();

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Trust proxy (for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: config.CORS_ORIGIN,
  credentials: true,
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
if (config.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', {
    stream: {
      write: (message) => logger.info(message.trim()),
    },
  }));
}

// Rate limiting
app.use('/api', apiLimiter);

// API routes
app.use('/api', routes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Notu.AI Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      upload: 'POST /api/upload',
      meetings: '/api/meetings',
    },
  });
});

// 404 handler
app.use(notFoundHandler);

// Error handler (must be last)
app.use(errorHandler);

/**
 * Initialize services and start server
 */
async function startServer() {
  try {
    logger.info('Starting Notu.AI Backend Server...');

    // Connect to MongoDB
    await connectDatabase();
    logger.info('✓ MongoDB connected');

    // Connect to Redis
    createRedisClient();
    logger.info('✓ Redis connected');

    // Ensure MinIO bucket exists
    await ensureBucket();
    logger.info('✓ MinIO bucket ready');

    // Initialize job queue
    createTranscriptionQueue();
    logger.info('✓ Job queue initialized');

    // Start transcription worker
    startTranscriptionWorker();
    logger.info('✓ Transcription worker started');

    // Start Express server
    const PORT = config.PORT;
    app.listen(PORT, () => {
      logger.info(`✓ Server running on port ${PORT}`);
      logger.info(`Environment: ${config.NODE_ENV}`);
      logger.info(`API: http://localhost:${PORT}/api`);
      logger.info(`Health: http://localhost:${PORT}/api/health`);
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled Promise Rejection:', error);
});

// Start the server
if (require.main === module) {
  startServer();
}

module.exports = app;
