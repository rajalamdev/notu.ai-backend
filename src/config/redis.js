const Redis = require('ioredis');
const config = require('./env');
const logger = require('../utils/logger');

let redisClient = null;

function createRedisClient() {
  if (redisClient) {
    return redisClient;
  }

  redisClient = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: true,
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  });

  redisClient.on('connect', () => {
    logger.info('Redis connected successfully');
  });

  redisClient.on('error', (err) => {
    logger.error('Redis connection error:', err);
  });

  redisClient.on('close', () => {
    logger.warn('Redis connection closed');
  });

  return redisClient;
}

function getRedisClient() {
  if (!redisClient) {
    return createRedisClient();
  }
  return redisClient;
}

async function disconnectRedis() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis disconnected');
  }
}

module.exports = {
  createRedisClient,
  getRedisClient,
  disconnectRedis,
};
