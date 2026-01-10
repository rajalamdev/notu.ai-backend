const botSessionService = require('../services/botSessionService');
const { emitBotStatus } = require('../services/socketService');
const logger = require('../utils/logger');

/**
 * Receive audio chunk from bot service
 * POST /api/meetings/:id/audio-chunk
 */
async function receiveAudioChunk(req, res, next) {
  try {
    const { id } = req.params;
    const { sessionId, chunkIndex } = req.body;
    const audioFile = req.file; // Multer will parse the audio file

    if (!audioFile) {
      return res.status(400).json({
        success: false,
        error: 'No audio file provided',
      });
    }

    logger.info(`[AudioChunk] Received chunk ${chunkIndex} for meeting ${id}: ${audioFile.size} bytes`);

    // Process audio chunk through bot session service
    const result = await botSessionService.processBotAudioChunk(
      id,
      audioFile.buffer,
      parseInt(chunkIndex, 10)
    );

    if (result.success) {
      // Emit live preview update via Socket.IO
      emitBotStatus(id, 'bot_preview', result.text, {
        chunkIndex: result.chunkIndex,
        accumulatedText: result.accumulatedText,
        processingTime: result.processingTime,
      });

      logger.debug(`[AudioChunk] Chunk ${chunkIndex} processed successfully`);
    } else {
      logger.warn(`[AudioChunk] Chunk ${chunkIndex} processing failed:`, result.error);
    }

    // Return success even if processing failed (bot will continue)
    res.json({
      success: true,
      chunkIndex: result.chunkIndex,
      textLength: result.text?.length || 0,
    });

  } catch (error) {
    logger.error('Error receiving audio chunk:', error);
    // Don't fail the request - return success so bot continues
    res.json({
      success: true,
      error: error.message,
    });
  }
}

module.exports = { receiveAudioChunk };
