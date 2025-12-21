const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const config = require('../config/env');
const logger = require('../utils/logger');
const { WHISPERX_DEFAULTS } = require('../utils/constants');

/**
 * Validate WhisperX API response
 */
function validateWhisperXResponse(data) {
  const errors = [];

  if (!data) {
    throw new Error('WhisperX response is empty');
  }

  if (!data.segments || !Array.isArray(data.segments)) {
    errors.push('Missing or invalid segments array');
  }

  if (!data.transcript || typeof data.transcript !== 'string') {
    errors.push('Missing or invalid transcript string');
  }

  if (!data.speakers || !Array.isArray(data.speakers)) {
    errors.push('Missing or invalid speakers array');
  }

  if (!data.metadata || typeof data.metadata !== 'object') {
    errors.push('Missing or invalid metadata');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid WhisperX response: ${errors.join(', ')}`);
  }

  return true;
}

/**
 * Send audio file to WhisperX API for transcription
 */
async function transcribeAudio(fileStream, filename, meetingId, options = {}) {
  const {
    numSpeakers = WHISPERX_DEFAULTS.NUM_SPEAKERS,
    enableSummary = WHISPERX_DEFAULTS.ENABLE_SUMMARY,
  } = options;

  // Convert stream to buffer with size limit
  const MAX_BUFFER_SIZE = 100 * 1024 * 1024; // 100MB
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of fileStream) {
    totalSize += chunk.length;
    
    if (totalSize > MAX_BUFFER_SIZE) {
      throw new Error(`File too large: ${totalSize} bytes exceeds maximum ${MAX_BUFFER_SIZE} bytes`);
    }
    
    chunks.push(chunk);
  }
  
  const buffer = Buffer.concat(chunks);
  logger.info(`Buffer created: ${totalSize} bytes for file ${filename}`);

  const formData = new FormData();
  formData.append('file', buffer, { filename });
  formData.append('meeting_id', meetingId);
  formData.append('num_speakers', numSpeakers.toString());
  formData.append('enable_summary', enableSummary.toString());

  const startTime = Date.now();

  try {
    logger.info(`Sending file to WhisperX API: ${filename} (${buffer.length} bytes), Meeting ID: ${meetingId}`);
    
    const response = await axios.post(
      `${config.WHISPERX_API_URL}/transcribe`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 600000, // 10 minutes
      }
    );

    const processingTime = Math.floor((Date.now() - startTime) / 1000);
    logger.info(`WhisperX transcription completed in ${processingTime}s`);

    // Validate response before returning
    validateWhisperXResponse(response.data);

    return {
      ...response.data,
      processingTime,
    };
  } catch (error) {
    logger.error('WhisperX API error:', error.message);
    if (error.response) {
      logger.error('WhisperX API response:', error.response.data);
      throw new Error(`WhisperX API error: ${error.response.data.error || error.message}`);
    }
    throw new Error(`WhisperX API connection error: ${error.message}`);
  }
}

/**
 * Check WhisperX API health
 */
async function checkHealth() {
  try {
    const response = await axios.get(`${config.WHISPERX_API_URL}/health`, {
      timeout: 5000,
    });
    return response.data;
  } catch (error) {
    logger.error('WhisperX health check failed:', error.message);
    return { status: 'unhealthy', error: error.message };
  }
}

module.exports = {
  transcribeAudio,
  checkHealth,
};
