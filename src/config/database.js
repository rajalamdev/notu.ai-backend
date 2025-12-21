const mongoose = require('mongoose');
const config = require('./env');
const logger = require('../utils/logger');

let isConnected = false;

async function connectDatabase() {
  if (isConnected) {
    logger.info('Using existing database connection');
    return;
  }

  try {
    await mongoose.connect(config.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    isConnected = true;
    logger.info('MongoDB connected successfully');

    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
      isConnected = false;
    });

  } catch (error) {
    logger.error('MongoDB connection failed:', error);
    throw error;
  }
}

async function disconnectDatabase() {
  if (!isConnected) return;

  try {
    await mongoose.disconnect();
    isConnected = false;
    logger.info('MongoDB disconnected');
  } catch (error) {
    logger.error('Error disconnecting from MongoDB:', error);
    throw error;
  }
}

module.exports = {
  connectDatabase,
  disconnectDatabase,
};
