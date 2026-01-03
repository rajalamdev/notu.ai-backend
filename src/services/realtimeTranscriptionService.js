const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../utils/logger');

// Generate UUID v4 using crypto
const generateSessionId = () => crypto.randomUUID();

/**
 * Realtime Transcription Service
 * Manages realtime transcription sessions and communicates with faster-whisper
 */

// Store active sessions with their audio buffers
const activeSessions = new Map();

/**
 * Create a new realtime transcription session
 */
function createSession(userId, meetingName = '') {
  const sessionId = generateSessionId();
  const session = {
    id: sessionId,
    userId,
    meetingName,
    audioChunks: [],
    transcriptParts: [],
    startedAt: new Date(),
    lastActivity: new Date(),
    status: 'active', // 'active', 'processing', 'completed', 'error'
    totalDuration: 0,
  };
  
  activeSessions.set(sessionId, session);
  logger.info(`[Realtime] Created session: ${sessionId} for user: ${userId}`);
  
  return session;
}

/**
 * Get session by ID
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Add audio chunk to session and process for preview
 */
async function processAudioChunk(sessionId, audioBuffer, chunkIndex) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  
  // Store chunk for final processing
  session.audioChunks.push({
    index: chunkIndex,
    buffer: audioBuffer,
    timestamp: new Date(),
  });
  session.lastActivity = new Date();
  
  // Send to Python for quick transcription
  try {
    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: `chunk_${chunkIndex}.webm`,
      contentType: 'audio/webm',
    });
    formData.append('session_id', sessionId);
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
    
    if (response.data.text) {
      session.transcriptParts.push({
        index: chunkIndex,
        text: response.data.text,
        timestamp: new Date(),
      });
    }
    
    return {
      success: true,
      text: response.data.text || '',
      chunkIndex,
      processingTime: response.data.processing_time,
    };
  } catch (error) {
    logger.error(`[Realtime] Chunk processing error: ${error.message}`);
    return {
      success: false,
      error: error.message,
      chunkIndex,
    };
  }
}

/**
 * Finalize session and get complete transcription with diarization
 * @param {string} sessionId - Session identifier
 * @param {Buffer|null} completeAudioBuffer - Complete audio from frontend (preferred)
 * @param {object} options - Processing options
 */
async function finalizeSession(sessionId, completeAudioBuffer = null, options = {}) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  
  session.status = 'processing';
  
  try {
    // Use complete audio from frontend if provided, otherwise combine chunks
    let audioBuffer;
    
    if (completeAudioBuffer && completeAudioBuffer.length > 0) {
      // Use the complete audio sent from frontend (preferred - has proper WebM headers)
      audioBuffer = completeAudioBuffer;
      logger.info(`[Realtime] Using complete audio from frontend: ${audioBuffer.length} bytes`);
    } else {
      // Fallback: Combine chunks (may have header issues with WebM)
      const sortedChunks = session.audioChunks
        .sort((a, b) => a.index - b.index)
        .map(c => c.buffer);
      
      if (sortedChunks.length === 0) {
        throw new Error('No audio data available');
      }
      
      audioBuffer = Buffer.concat(sortedChunks);
      logger.info(`[Realtime] Combined ${sortedChunks.length} chunks: ${audioBuffer.length} bytes`);
    }
    
    // Send audio for final processing
    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: 'recording.webm',
      contentType: 'audio/webm',
    });
    formData.append('session_id', sessionId);
    formData.append('num_speakers', options.numSpeakers?.toString() || '');
    formData.append('language', options.language || '');
    formData.append('enable_ai_notes', options.enableAiNotes !== false ? 'true' : 'false');
    
    const response = await axios.post(
      `${config.WHISPERX_API_URL}/transcribe/realtime/final`,
      formData,
      {
        headers: formData.getHeaders(),
        maxBodyLength: Infinity,
        timeout: 600000, // 10 minutes for final processing
      }
    );
    
    session.status = 'completed';
    session.endedAt = new Date();
    session.finalResult = response.data;
    
    // Store audio buffer for potential saving later
    session.audioBuffer = audioBuffer;
    
    logger.info(`[Realtime] Session ${sessionId} finalized successfully`);
    
    // Convert snake_case to camelCase for frontend compatibility
    const result = {
      success: true,
      sessionId,
      transcript: response.data.transcript,
      segments: response.data.segments,
      speakers: response.data.speakers,
      numSpeakers: response.data.num_speakers,
      duration: response.data.duration,
      processingTime: response.data.processing_time,
      language: response.data.language,
      diarizationMethod: response.data.diarization_method,
      // Convert ai_notes to aiNotes
      aiNotes: response.data.ai_notes ? {
        summary: response.data.ai_notes.summary || '',
        highlights: response.data.ai_notes.highlights || {},
        conclusion: response.data.ai_notes.conclusion || '',
        actionItems: response.data.ai_notes.actionItems || [],
        suggestedTitle: response.data.ai_notes.suggestedTitle || '',
        suggestedDescription: response.data.ai_notes.suggestedDescription || '',
        tags: response.data.ai_notes.tags || [],
      } : null,
    };
    
    return result;
  } catch (error) {
    session.status = 'error';
    session.error = error.message;
    logger.error(`[Realtime] Finalization error for ${sessionId}: ${error.message}`);
    
    throw error;
  }
}

/**
 * Cancel and cleanup session
 */
function cancelSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.status = 'cancelled';
    // Clear audio chunks to free memory
    session.audioChunks = [];
    activeSessions.delete(sessionId);
    logger.info(`[Realtime] Session ${sessionId} cancelled and cleaned up`);
  }
}

/**
 * Get session preview transcript (accumulated)
 */
function getSessionPreview(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return null;
  }
  
  const sortedParts = session.transcriptParts
    .sort((a, b) => a.index - b.index)
    .map(p => p.text);
  
  return {
    sessionId,
    text: sortedParts.join(' '),
    chunksProcessed: session.transcriptParts.length,
    totalChunks: session.audioChunks.length,
    duration: session.startedAt ? (Date.now() - session.startedAt.getTime()) / 1000 : 0,
  };
}

/**
 * Cleanup old sessions (for memory management)
 */
function cleanupOldSessions(maxAgeMinutes = 60) {
  const now = Date.now();
  const maxAge = maxAgeMinutes * 60 * 1000;
  
  for (const [sessionId, session] of activeSessions.entries()) {
    const age = now - session.lastActivity.getTime();
    if (age > maxAge) {
      logger.info(`[Realtime] Cleaning up stale session: ${sessionId}`);
      activeSessions.delete(sessionId);
    }
  }
}

// Cleanup old sessions every 10 minutes
setInterval(() => cleanupOldSessions(60), 10 * 60 * 1000);

module.exports = {
  createSession,
  getSession,
  processAudioChunk,
  finalizeSession,
  cancelSession,
  getSessionPreview,
  cleanupOldSessions,
};
