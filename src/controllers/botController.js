/**
 * Bot Controller
 * 
 * Handles bot-related API endpoints and proxies requests to bot service
 */

const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const botSessionService = require('../services/botSessionService');
const { emitToMeeting, emitBotStatus, emitCaptionAdded } = require('../services/socketService');

/**
 * Start bot for a meeting
 * POST /api/bot/join
 */
async function startBot(req, res, next) {
  try {
    const { meetingUrl, meetingId, duration, botName } = req.body;
    
    if (!meetingUrl || !meetingId) {
      return res.status(400).json({
        success: false,
        error: 'meetingUrl and meetingId are required',
      });
    }

    logger.info(`[BotController] Starting bot for meeting ${meetingId}`);

    // Update Meeting status immediately so frontend shows progress right away
    const Meeting = require('../models/Meeting');
    const meeting = await Meeting.findById(meetingId);
    if (meeting) {
      meeting.status = 'bot_joining';
      meeting.processingStage = 'bot_connecting';
      meeting.processingProgress = 10;
      meeting.processingLogs = [{
        message: '🤖 Menghubungkan bot ke meeting...',
        timestamp: new Date(),
        stage: 'bot_connecting'
      }];
      await meeting.save();
      logger.info(`[BotController] Meeting ${meetingId} status set to bot_joining`);
    }

    // Create local session
    const session = botSessionService.createBotSession(
      meetingId,
      req.user?.id,
      meetingUrl,
      { botName, duration }
    );

    // Forward request to bot service
    const botServiceUrl = config.BOT_SERVICE_URL || 'http://localhost:3001';
    
    try {
      const response = await axios.post(`${botServiceUrl}/api/bot/join`, {
        meetingUrl,
        meetingId,
        duration: duration || 120,
        botName: botName || 'Notu.AI Bot',
      }, {
        timeout: 15000,
      });

      // Update to bot_joining stage (bot accepted the request)
      if (meeting) {
        meeting.processingStage = 'bot_joining';
        meeting.processingProgress = 25;
        meeting.processingLogs.push({
          message: '📍 Bot sedang bergabung ke meeting...',
          timestamp: new Date(),
          stage: 'bot_joining'
        });
        await meeting.save();
      }

      botSessionService.updateBotSessionStatus(meetingId, 'bot_joining');

      res.json({
        success: true,
        message: 'Bot started successfully',
        data: {
          sessionId: session.sessionId,
          meetingId,
          botSession: response.data,
        },
      });
    } catch (botError) {
      logger.warn(`[BotController] Bot service unavailable: ${botError.message}`);
      
      // Bot service unavailable - update session status
      botSessionService.updateBotSessionStatus(meetingId, 'failed', 'Bot service unavailable');

      res.status(503).json({
        success: false,
        error: 'Bot service unavailable',
        message: 'Please ensure the bot service is running',
      });
    }
  } catch (error) {
    logger.error('[BotController] Start bot error:', error);
    next(error);
  }
}

/**
 * Stop bot for a meeting
 * POST /api/bot/:meetingId/stop
 */
async function stopBot(req, res, next) {
  try {
    const { meetingId } = req.params;
    const { reason } = req.body;

    logger.info(`[BotController] Stopping bot for meeting ${meetingId}`);

    const botServiceUrl = config.BOT_SERVICE_URL || 'http://localhost:3001';
    
    try {
      const response = await axios.post(`${botServiceUrl}/api/bot/${meetingId}/stop`, {
        reason: reason || 'user_requested',
      }, {
        timeout: 10000,
      });

      // Update local session
      botSessionService.updateBotSessionStatus(meetingId, 'completed');

      res.json({
        success: true,
        message: 'Bot stopped successfully',
        data: response.data,
      });
    } catch (botError) {
      logger.warn(`[BotController] Failed to stop bot: ${botError.message}`);

      // Try to cleanup local session anyway
      botSessionService.cancelBotSession(meetingId);

      res.status(500).json({
        success: false,
        error: 'Failed to stop bot',
        message: botError.message,
      });
    }
  } catch (error) {
    logger.error('[BotController] Stop bot error:', error);
    next(error);
  }
}

/**
 * Get bot status for a meeting
 * GET /api/bot/:meetingId/status
 */
async function getBotStatus(req, res, next) {
  try {
    const { meetingId } = req.params;

    // Check local session first
    const localSession = botSessionService.getBotSession(meetingId);
    
    if (localSession) {
      return res.json({
        success: true,
        data: {
          sessionId: localSession.sessionId,
          meetingId,
          status: localSession.status,
          chunksProcessed: localSession.totalChunksReceived,
          previewLength: localSession.accumulatedText.length,
          createdAt: localSession.createdAt,
          startedAt: localSession.startedAt,
        },
      });
    }

    // Try bot service
    const botServiceUrl = config.BOT_SERVICE_URL || 'http://localhost:3001';
    
    try {
      const response = await axios.get(`${botServiceUrl}/api/bot/${meetingId}/status`, {
        timeout: 5000,
      });

      res.json({
        success: true,
        data: response.data,
      });
    } catch (botError) {
      res.status(404).json({
        success: false,
        error: 'Bot session not found',
      });
    }
  } catch (error) {
    logger.error('[BotController] Get status error:', error);
    next(error);
  }
}

/**
 * Receive segments from bot service
 * POST /api/bot/:meetingId/segments
 */
async function receiveSegments(req, res, next) {
  try {
    const { meetingId } = req.params;
    const { segments } = req.body;

    // Log incoming request for debugging
    logger.info(`[BotController] Segments request - meetingId: ${meetingId}, segments count: ${segments?.length || 0}`);

    // Validate segments - be lenient
    if (!segments) {
      logger.warn(`[BotController] No segments in request body for meeting ${meetingId}`);
      return res.json({
        success: true,
        received: 0,
        message: 'No segments provided',
      });
    }

    if (!Array.isArray(segments)) {
      logger.warn(`[BotController] Segments is not an array for meeting ${meetingId}`);
      return res.status(400).json({
        success: false,
        error: 'segments must be an array',
      });
    }

    // Try to update meeting status and logs (don't fail if meeting not found)
    try {
      const Meeting = require('../models/Meeting');
      const meeting = await Meeting.findById(meetingId);
      
      if (meeting) {
        // Update status to recording if not already
        if (meeting.status !== 'recording' && meeting.status !== 'completed') {
          meeting.status = 'recording';
          meeting.processingStage = 'bot_recording';
        }
        meeting.processingProgress = 50; // Mid recording
        
        // Add latest captions to processingLogs (keep last 10)
        const newLogs = segments.slice(-3).map(s => ({
          message: `${s.speaker}: ${s.text}`,
          timestamp: new Date(),
          stage: 'bot_recording'
        }));
        
        // Merge with existing logs, keep last 10
        meeting.processingLogs = [
          ...(meeting.processingLogs || []).slice(-7),
          ...newLogs
        ].slice(-10);
        
        await meeting.save();
        logger.info(`[BotController] Meeting ${meetingId} updated with ${segments.length} segments`);
      } else {
        logger.warn(`[BotController] Meeting ${meetingId} not found in database (segments will still be emitted)`);
      }
    } catch (dbError) {
      logger.error(`[BotController] Database error for meeting ${meetingId}:`, dbError.message);
      // Continue - don't fail just because of DB error
    }

    // Emit each segment to connected clients via WebSocket
    for (const segment of segments) {
      emitCaptionAdded(meetingId, segment);
    }

    // Also emit global event for dashboard monitoring
    emitBotStatus(meetingId, 'recording', {
      segmentCount: segments.length,
      latestCaption: segments[segments.length - 1]?.text?.substring(0, 100),
    });

    res.json({
      success: true,
      received: segments.length,
    });
  } catch (error) {
    logger.error('[BotController] Receive segments error:', error);
    // Return success anyway - don't break bot flow
    res.json({
      success: true,
      received: 0,
      error: error.message,
    });
  }
}

/**
 * Finalize bot session
 * POST /api/bot/:meetingId/finalize
 */
async function finalizeBotSession(req, res, next) {
  try {
    const { meetingId } = req.params;
    const { sessionId, segments, duration } = req.body;

    logger.info(`[BotController] Finalizing bot session for meeting ${meetingId}, ${segments?.length || 0} segments`);

    // Format transcript from segments
    const transcriptText = segments
      ?.map(s => `${s.speaker}: ${s.text}`)
      .join('\n') || '';

    // Format segments for DB (speaker-based format)
    const formattedSegments = segments?.map((s, idx) => ({
      speaker: s.speaker || 'Unknown',
      text: s.text || '',
      startTime: s.start || idx,
      endTime: s.end || idx + 1,
    })) || [];

    // Update Meeting in database
    const Meeting = require('../models/Meeting');
    const meeting = await Meeting.findById(meetingId);
    
    if (meeting) {
      // Update meeting with bot transcript
      meeting.status = 'completed';
      meeting.transcript = transcriptText;
      meeting.segments = formattedSegments;
      meeting.duration = duration || 0;
      meeting.processingProgress = 100;
      meeting.processingStage = 'completed';
      meeting.completedAt = new Date();
      
      // Generate basic summary from transcript
      if (transcriptText && !meeting.summary) {
        meeting.summary = transcriptText.substring(0, 500) + (transcriptText.length > 500 ? '...' : '');
      }
      
      await meeting.save();
      logger.info(`[BotController] Meeting ${meetingId} updated with bot transcript`);
      
      // Trigger AI analysis asynchronously (don't block response)
      if (transcriptText && transcriptText.length > 50) {
        setImmediate(async () => {
          try {
            logger.info(`[BotController] Starting AI analysis for meeting ${meetingId}`);
            const { analyzeTranscript } = require('../services/whisperxService');
            const aiResult = await analyzeTranscript(transcriptText);
            
            // Update meeting with AI results
            const meetingToUpdate = await Meeting.findById(meetingId);
            if (meetingToUpdate && aiResult) {
              if (aiResult.summary) {
                meetingToUpdate.transcription = meetingToUpdate.transcription || {};
                meetingToUpdate.transcription.summary = aiResult.summary;
              }
              if (aiResult.highlights) {
                meetingToUpdate.transcription.highlights = aiResult.highlights;
              }
              if (aiResult.conclusion) {
                meetingToUpdate.transcription.conclusion = aiResult.conclusion;
              }
              if (aiResult.actionItems && Array.isArray(aiResult.actionItems)) {
                meetingToUpdate.actionItems = aiResult.actionItems.map(ai => ({
                  title: ai.title || ai.text,
                  description: ai.description || '',
                  priority: ai.priority || 'medium',
                  dueDate: ai.dueDate,
                  dueDateRaw: ai.dueDateRaw,
                  assigneeName: ai.assignee || ai.assigneeName,
                  status: 'todo'
                }));
              }
              if (aiResult.suggestedTitle) {
                meetingToUpdate.suggestedTitle = aiResult.suggestedTitle;
              }
              await meetingToUpdate.save();
              logger.info(`[BotController] AI analysis completed for meeting ${meetingId}`);
              
              // Emit update to frontend
              emitBotStatus(meetingId, 'ai_completed', {
                hasSummary: !!aiResult.summary,
                actionItemsCount: aiResult.actionItems?.length || 0,
              });
            }
          } catch (aiError) {
            logger.error(`[BotController] AI analysis failed for meeting ${meetingId}:`, aiError.message);
            // Don't fail - meeting is already saved with transcript
          }
        });
      }
    } else {
      logger.warn(`[BotController] Meeting ${meetingId} not found in DB`);
    }

    // Update local session
    const session = botSessionService.getBotSession(meetingId);
    if (session) {
      session.previewTexts = segments?.map((s, idx) => ({
        index: idx,
        text: `${s.speaker}: ${s.text}`,
        timestamp: new Date(),
        processingTime: 0,
      })) || [];
      session.accumulatedText = transcriptText;
    }

    // Emit completion event to frontend
    emitBotStatus(meetingId, 'completed', {
      segmentCount: segments?.length || 0,
      duration: duration || 0,
      transcript: transcriptText,
    });

    res.json({
      success: true,
      message: 'Bot session finalized',
      data: {
        meetingId,
        segmentCount: segments?.length || 0,
        transcriptLength: transcriptText.length,
      },
    });
  } catch (error) {
    logger.error('[BotController] Finalize error:', error);
    next(error);
  }
}

/**
 * Get all active bot sessions
 * GET /api/bot/sessions
 */
async function getAllSessions(req, res, next) {
  try {
    const sessions = botSessionService.getAllBotSessions();

    res.json({
      success: true,
      data: sessions,
      count: sessions.length,
    });
  } catch (error) {
    logger.error('[BotController] Get sessions error:', error);
    next(error);
  }
}

module.exports = {
  startBot,
  stopBot,
  getBotStatus,
  receiveSegments,
  finalizeBotSession,
  getAllSessions,
};
