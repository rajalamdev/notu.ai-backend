const { Queue, Worker } = require('bullmq');
const { getRedisClient } = require('../config/redis');
const logger = require('../utils/logger');
const { QUEUE_NAMES, MAX_RETRIES, RETRY_DELAY } = require('../utils/constants');

let transcriptionQueue = null;

/**
 * Initialize transcription queue
 */
function createTranscriptionQueue() {
  if (transcriptionQueue) {
    return transcriptionQueue;
  }

  const connection = getRedisClient();

  transcriptionQueue = new Queue(QUEUE_NAMES.TRANSCRIPTION, {
    connection,
    defaultJobOptions: {
      attempts: MAX_RETRIES,
      backoff: {
        type: 'exponential',
        delay: RETRY_DELAY,
      },
      timeout: 900000, // 15 minutes max per job
      removeOnComplete: {
        count: 100, // Keep last 100 completed jobs
        age: 86400, // Keep for 24 hours
      },
      removeOnFail: {
        count: 200, // Keep last 200 failed jobs
        age: 172800, // Keep for 48 hours
      },
    },
  });

  transcriptionQueue.on('error', (error) => {
    logger.error('Queue error:', error);
  });

  logger.info('Transcription queue initialized with 15-minute timeout');
  return transcriptionQueue;
}

/**
 * Get transcription queue instance
 */
function getTranscriptionQueue() {
  if (!transcriptionQueue) {
    return createTranscriptionQueue();
  }
  return transcriptionQueue;
}

/**
 * Add transcription job to queue
 */
async function addTranscriptionJob(meetingId, options = {}) {
  try {
    const queue = getTranscriptionQueue();
    
    const job = await queue.add(
      'transcribe',
      {
        meetingId,
        ...options,
      },
      {
        priority: options.priority || 5,
        jobId: `transcription-${meetingId}`,
      }
    );

    logger.info(`Transcription job added to queue: ${job.id}`);
    return job;
  } catch (error) {
    logger.error('Error adding job to queue:', error);
    throw error;
  }
}

/**
 * Get job status
 */
async function getJobStatus(jobId) {
  try {
    const queue = getTranscriptionQueue();
    const job = await queue.getJob(jobId);
    
    if (!job) {
      return null;
    }

    const state = await job.getState();
    const progress = job.progress;
    const failedReason = job.failedReason;

    return {
      id: job.id,
      state,
      progress,
      failedReason,
      attemptsMade: job.attemptsMade,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
    };
  } catch (error) {
    logger.error('Error getting job status:', error);
    return null;
  }
}

/**
 * Create transcription worker
 */
function createTranscriptionWorker(processor) {
  const connection = getRedisClient();

  const worker = new Worker(
    QUEUE_NAMES.TRANSCRIPTION,
    processor,
    {
      connection,
      concurrency: 2, // Process 2 jobs at a time
      limiter: {
        max: 5, // Max 5 jobs
        duration: 60000, // per minute
      },
    }
  );

  worker.on('completed', (job) => {
    logger.info(`Job completed: ${job.id}`);
  });

  worker.on('failed', (job, error) => {
    logger.error(`Job failed: ${job.id}`, error);
  });

  worker.on('error', (error) => {
    logger.error('Worker error:', error);
  });

  logger.info('Transcription worker started');
  return worker;
}

/**
 * Close queue and worker
 */
async function closeQueue() {
  if (transcriptionQueue) {
    await transcriptionQueue.close();
    transcriptionQueue = null;
    logger.info('Transcription queue closed');
  }
}

module.exports = {
  createTranscriptionQueue,
  getTranscriptionQueue,
  addTranscriptionJob,
  getJobStatus,
  createTranscriptionWorker,
  closeQueue,
};
