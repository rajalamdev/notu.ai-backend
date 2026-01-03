const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const config = require('../config/env');
const logger = require('../utils/logger');
const { WHISPERX_DEFAULTS } = require('../utils/constants');
const EventSource = require('eventsource');

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

  // Stream directly without buffering in memory to handle large files > 100MB
  // const MAX_BUFFER_SIZE = 100 * 1024 * 1024; // Removed size limit logic
  
  const formData = new FormData();
  formData.append('file', fileStream, { filename });
  formData.append('meeting_id', meetingId);
  formData.append('num_speakers', numSpeakers.toString());
  formData.append('enable_summary', enableSummary.toString());

  const startTime = Date.now();

  try {
    logger.info(`Sending file stream to WhisperX API: ${filename}, Meeting ID: ${meetingId}`);
    
    // Calculate headers separately to include boundary
    const headers = formData.getHeaders();

    const response = await axios.post(
      `${config.WHISPERX_API_URL}/transcribe`,
      formData,
      {
        headers,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 1800000, // 30 minutes (increased for CPU processing)
      }
    );

    const processingTime = Math.floor((Date.now() - startTime) / 1000);
    logger.info(`WhisperX transcription completed in ${processingTime}s`);

    // Validate response before returning
    validateWhisperXResponse(response.data);

    // Log chunking metadata if present
    if (response.data.metadata?.chunking) {
      const chunking = response.data.metadata.chunking;
      logger.info(`Chunking used: ${chunking.chunking_used}, Chunks: ${chunking.total_chunks || 1}`);
    }

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
 * Transcribe audio with streaming progress updates via SSE
 * @param {Buffer} fileBuffer - The audio file buffer
 * @param {string} filename - Original filename
 * @param {string} meetingId - Meeting ID for tracking
 * @param {Object} options - Transcription options
 * @param {Function} onProgress - Progress callback (stage, progress, message, data)
 * @returns {Promise<Object>} Transcription result
 */
async function transcribeAudioWithProgress(fileBuffer, filename, meetingId, options = {}, onProgress = null) {
  const {
    numSpeakers = WHISPERX_DEFAULTS.NUM_SPEAKERS,
    language = null,
  } = options;

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    // Create form data for file upload
    const formData = new FormData();
    formData.append('file', fileBuffer, { filename });
    formData.append('meeting_id', meetingId);
    formData.append('num_speakers', numSpeakers.toString());
    if (language) {
      formData.append('language', language);
    }

    logger.info(`Starting streaming transcription for: ${filename}, Meeting ID: ${meetingId}`);

    // Post file and get SSE stream
    axios.post(
      `${config.WHISPERX_API_URL}/transcribe/stream`,
      formData,
      {
        headers: formData.getHeaders(),
        responseType: 'stream',
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 1800000, // 30 minutes
      }
    ).then(response => {
      let result = null;
      let buffer = '';

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        
        // Process complete SSE messages
        const lines = buffer.split('\n\n');
        buffer = lines.pop(); // Keep incomplete message in buffer
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              // Log every event received for debugging
              logger.info(`[SSE] Received: type=${data.type}, stage=${data.stage || 'N/A'}, progress=${data.progress || 'N/A'}`);
              
              if (data.type === 'progress' && onProgress) {
                // Forward ALL progress events to frontend
                onProgress(data.stage, data.progress, data.message, {
                  chunk: data.chunk,
                  totalChunks: data.total_chunks,
                });
              } else if (data.type === 'transcript_chunk') {
                // Don't emit progress for transcript chunks - just log
                logger.debug(`Received transcript chunk ${data.chunk_index}`);
              } else if (data.type === 'complete') {
                result = data;
                logger.info('[SSE] Received complete result');
                // NOTE: Removed duplicate completed emission - Python SSE already sends stage=completed with progress=100
              } else if (data.type === 'error') {
                throw new Error(data.error);
              }
            } catch (parseError) {
              logger.warn('Failed to parse SSE message:', parseError.message);
            }
          }
        }
      });

      response.data.on('end', () => {
        const processingTime = Math.floor((Date.now() - startTime) / 1000);
        
        if (result) {
          logger.info(`Streaming transcription completed in ${processingTime}s`);
          resolve({
            ...result,
            processingTime,
          });
        } else {
          reject(new Error('No result received from streaming transcription'));
        }
      });

      response.data.on('error', (error) => {
        logger.error('SSE stream error:', error);
        reject(error);
      });

    }).catch(error => {
      logger.error('Streaming transcription request failed:', error.message);
      reject(error);
    });
  });
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

/**
 * Regenerate AI notes from existing transcript text
 */
async function analyzeTranscript(transcript) {
  const timeout = (typeof arguments[1] === 'object' && arguments[1]?.timeout) || 1800000; // default 30 minutes
  const start = Date.now();
  try {
    const response = await axios.post(
      `${config.WHISPERX_API_URL}/analyze`,
      { transcript },
      { timeout }
    );

    const processingTime = Math.floor((Date.now() - start) / 1000);
    // Log simple metrics for monitoring
    try {
      const respSize = response && response.data ? JSON.stringify(response.data).length : 0;
      const keys = response && response.data && typeof response.data === 'object' ? Object.keys(response.data) : [];
      // Log top-level keys and response size to help debug missing fields
      logger.info(`Analyze transcript: completed in ${processingTime}s, response size=${respSize} bytes, keys=${keys.join(',')}`);

      // If LLM service includes diagnostics, log them at debug level
      try {
        const diag = response.data && (response.data.__llm_diagnostics || response.data.__diagnostics || null);
        if (diag) logger.debug('Analyze response diagnostics:', diag);
      } catch (e) {
        // ignore diagnostics logging errors
      }

      // Log whether action items exist and their count (if present)
      try {
        const ai = response.data && (response.data.actionItems || response.data.action_items || []);
        const aiCount = Array.isArray(ai) ? ai.length : (ai ? 1 : 0);
        logger.info(`Analyze transcript: action_items_count=${aiCount}`);
        try {
          // Log a compact sample of action items (dueDate/dueDateRaw) to help diagnose parsing issues
          const sample = Array.isArray(ai) ? ai.slice(0, 5).map(a => ({
            title: a?.title || a?.text || null,
            dueDate: a?.dueDate ?? a?.due_date ?? null,
            dueDateRaw: a?.dueDateRaw ?? a?.due_date_raw ?? null
          })) : ai;
          logger.debug('Analyze response action_items sample:', JSON.stringify(sample));
        } catch (e) {
          // ignore sample logging errors
        }
      } catch (e) {
        // ignore
      }
    } catch (e) {
      logger.info(`Analyze transcript completed in ${processingTime}s`);
    }

    return {
      ...response.data,
      processingTime,
    };
  } catch (error) {
    const processingTime = Math.floor((Date.now() - start) / 1000);
    logger.error('Analyze transcript error:', error.message, { processingTime });
    if (error.response) {
      logger.error('Analyze transcript response error:', error.response.data);
      throw new Error(`WhisperX analyze error: ${error.response.data.error || error.message}`);
    }
    throw new Error(`WhisperX analyze connection error: ${error.message}`);
  }
}

module.exports = {
  transcribeAudio,
  transcribeAudioWithProgress,
  analyzeTranscript,
  checkHealth,
};
