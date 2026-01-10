/**
 * Bot Session Service
 * Manages bot transcription sessions - similar to realtimeTranscriptionService
 * but optimized for bot audio capture (text-only preview, no diarization during live)
 */

const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../utils/logger');

// Generate session ID
const generateSessionId = () => crypto.randomUUID();

// Store active bot sessions
const activeBotSessions = new Map();

// Session status constants
const BOT_SESSION_STATUS = {
  PENDING: 'pending',
  BOT_JOINING: 'bot_joining',
  BOT_IN_MEETING: 'bot_in_meeting',
  RECORDING: 'recording',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/**
 * Create a new bot session
 */
function createBotSession(meetingId, userId, meetingUrl, options = {}) {
  const sessionId = generateSessionId();
  
  const session = {
    sessionId,
    meetingId,
    userId,
    meetingUrl,
    botName: options.botName || 'Notu.AI Bot',
    maxDuration: options.duration || 120, // minutes
    status: BOT_SESSION_STATUS.PENDING,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    
    // Audio data
    audioChunks: [],
    totalChunksReceived: 0,
    
    // Transcription preview
    previewTexts: [],
    accumulatedText: '',
    
    // Error tracking
    error: null,
    
    // Complete audio for final processing
    completeAudio: null,
  };

  activeBotSessions.set(meetingId, session);
  logger.info(`[BotSession] Created session ${sessionId} for meeting ${meetingId}`);

  return session;
}

/**
 * Get session by meeting ID
 */
function getBotSession(meetingId) {
  return activeBotSessions.get(meetingId);
}

/**
 * Get session by session ID
 */
function getBotSessionBySessionId(sessionId) {
  for (const session of activeBotSessions.values()) {
    if (session.sessionId === sessionId) {
      return session;
    }
  }
  return null;
}

/**
 * Update bot session status
 */
function updateBotSessionStatus(meetingId, status, message = '') {
  const session = activeBotSessions.get(meetingId);
  if (!session) {
    logger.warn(`[BotSession] Session not found for meeting ${meetingId}`);
    return null;
  }

  session.status = status;
  
  if (status === BOT_SESSION_STATUS.RECORDING && !session.startedAt) {
    session.startedAt = new Date();
  }
  
  if (status === BOT_SESSION_STATUS.COMPLETED || status === BOT_SESSION_STATUS.FAILED) {
    session.completedAt = new Date();
    if (status === BOT_SESSION_STATUS.FAILED) {
      session.error = message;
    }
  }

  logger.info(`[BotSession] Meeting ${meetingId} status: ${status}`, { message });
  return session;
}

/**
 * Process audio chunk from bot
 * Sends to Python for quick text-only transcription (no diarization)
 */
async function processBotAudioChunk(meetingId, audioBuffer, chunkIndex) {
  const session = activeBotSessions.get(meetingId);
  if (!session) {
    throw new Error(`Session not found for meeting ${meetingId}`);
  }

  // Store chunk info
  session.audioChunks.push({
    index: chunkIndex,
    size: audioBuffer.length,
    timestamp: new Date(),
  });
  session.totalChunksReceived = chunkIndex;

  // Send to Python for quick transcription
  try {
    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: `bot_chunk_${chunkIndex}.webm`,
      contentType: 'audio/webm',
    });
    formData.append('session_id', session.sessionId);
    formData.append('is_final', 'false');

    const response = await axios.post(
      `${config.WHISPERX_API_URL}/transcribe/realtime`,
      formData,
      {
        headers: formData.getHeaders(),
        maxBodyLength: Infinity,
        timeout: 30000, // 30 seconds max for preview
      }
    );

    const text = response.data.text || '';

    if (text) {
      session.previewTexts.push({
        index: chunkIndex,
        text,
        timestamp: new Date(),
        processingTime: response.data.processing_time,
      });

      // Update accumulated text
      session.accumulatedText = session.previewTexts
        .sort((a, b) => a.index - b.index)
        .map(p => p.text)
        .join(' ');
    }

    logger.debug(`[BotSession] Chunk ${chunkIndex} processed: ${text.substring(0, 50)}...`);

    return {
      success: true,
      text,
      chunkIndex,
      processingTime: response.data.processing_time,
      accumulatedText: session.accumulatedText,
    };
  } catch (error) {
    logger.error(`[BotSession] Chunk processing error: ${error.message}`);
    return {
      success: false,
      error: error.message,
      chunkIndex,
    };
  }
}

/**
 * Store complete audio when bot finishes
 */
function storeCompleteAudio(meetingId, audioBuffer) {
  const session = activeBotSessions.get(meetingId);
  if (!session) {
    logger.warn(`[BotSession] Session not found for meeting ${meetingId}`);
    return false;
  }

  session.completeAudio = audioBuffer;
  logger.info(`[BotSession] Stored complete audio for meeting ${meetingId}: ${audioBuffer.length} bytes`);
  return true;
}

/**
 * Get session preview (accumulated text)
 */
function getBotSessionPreview(meetingId) {
  const session = activeBotSessions.get(meetingId);
  if (!session) {
    return null;
  }

  return {
    meetingId,
    sessionId: session.sessionId,
    status: session.status,
    accumulatedText: session.accumulatedText,
    chunksProcessed: session.previewTexts.length,
    totalChunks: session.totalChunksReceived,
    duration: session.startedAt
      ? Math.floor((Date.now() - session.startedAt.getTime()) / 1000)
      : 0,
  };
}

/**
 * Finalize bot session - process complete audio with diarization (optional)
 * For text-only mode, just save the accumulated transcript
 */
async function finalizeBotSession(meetingId, options = {}) {
  const session = activeBotSessions.get(meetingId);
  if (!session) {
    throw new Error(`Session not found for meeting ${meetingId}`);
  }

  session.status = BOT_SESSION_STATUS.PROCESSING;

  try {
    // If we have complete audio and want full processing with diarization
    if (session.completeAudio && options.enableDiarization) {
      const formData = new FormData();
      formData.append('file', session.completeAudio, {
        filename: 'bot_recording.webm',
        contentType: 'audio/webm',
      });
      formData.append('session_id', session.sessionId);
      formData.append('num_speakers', options.numSpeakers?.toString() || '');
      formData.append('language', options.language || '');
      formData.append('enable_ai_notes', options.enableAiNotes !== false ? 'true' : 'false');

      const response = await axios.post(
        `${config.WHISPERX_API_URL}/transcribe/realtime/final`,
        formData,
        {
          headers: formData.getHeaders(),
          maxBodyLength: Infinity,
          timeout: 600000, // 10 minutes
        }
      );

      session.status = BOT_SESSION_STATUS.COMPLETED;
      session.completedAt = new Date();

      return {
        success: true,
        meetingId,
        sessionId: session.sessionId,
        transcript: response.data.transcript,
        segments: response.data.segments,
        speakers: response.data.speakers,
        numSpeakers: response.data.num_speakers,
        duration: response.data.duration,
        processingTime: response.data.processing_time,
        language: response.data.language,
        diarizationMethod: response.data.diarization_method,
        aiNotes: response.data.ai_notes,
        mode: 'full_processing',
      };
    }

    // Text-only mode - just return accumulated transcript
    session.status = BOT_SESSION_STATUS.COMPLETED;
    session.completedAt = new Date();

    const duration = session.startedAt
      ? Math.floor((session.completedAt.getTime() - session.startedAt.getTime()) / 1000)
      : 0;

    return {
      success: true,
      meetingId,
      sessionId: session.sessionId,
      transcript: session.accumulatedText,
      segments: session.previewTexts.map((p, idx) => ({
        start: idx * 10, // Approximate timing based on chunk interval
        end: (idx + 1) * 10,
        text: p.text,
        speaker: 'SPEAKER_0', // No diarization in text-only mode
      })),
      speakers: { SPEAKER_0: duration },
      numSpeakers: 1,
      duration,
      processingTime: 0,
      language: 'id',
      mode: 'text_only',
    };
  } catch (error) {
    session.status = BOT_SESSION_STATUS.FAILED;
    session.error = error.message;
    logger.error(`[BotSession] Finalization error: ${error.message}`);
    throw error;
  }
}

/**
 * Cancel/cleanup bot session
 */
function cancelBotSession(meetingId) {
  const session = activeBotSessions.get(meetingId);
  if (session) {
    session.status = BOT_SESSION_STATUS.FAILED;
    session.error = 'cancelled';
    session.completeAudio = null;
    session.audioChunks = [];
    activeBotSessions.delete(meetingId);
    logger.info(`[BotSession] Session cancelled: ${meetingId}`);
  }
}

/**
 * Get all active sessions
 */
function getAllBotSessions() {
  const sessions = [];
  for (const [meetingId, session] of activeBotSessions.entries()) {
    sessions.push({
      meetingId,
      sessionId: session.sessionId,
      status: session.status,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      chunksReceived: session.totalChunksReceived,
      previewLength: session.accumulatedText.length,
    });
  }
  return sessions;
}

/**
 * Cleanup old sessions
 */
function cleanupOldBotSessions(maxAgeMinutes = 180) {
  const now = Date.now();
  const maxAge = maxAgeMinutes * 60 * 1000;

  for (const [meetingId, session] of activeBotSessions.entries()) {
    const age = now - session.createdAt.getTime();
    if (age > maxAge) {
      logger.info(`[BotSession] Cleaning up stale session: ${meetingId}`);
      activeBotSessions.delete(meetingId);
    }
  }
}

// Cleanup every 30 minutes
setInterval(() => cleanupOldBotSessions(180), 30 * 60 * 1000);

module.exports = {
  createBotSession,
  getBotSession,
  getBotSessionBySessionId,
  updateBotSessionStatus,
  processBotAudioChunk,
  storeCompleteAudio,
  getBotSessionPreview,
  finalizeBotSession,
  cancelBotSession,
  getAllBotSessions,
  cleanupOldBotSessions,
  BOT_SESSION_STATUS,
};
