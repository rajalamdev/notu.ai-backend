/**
 * Bot Controller
 * 
 * Handles bot-related API endpoints and proxies requests to bot service
 */

const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const botSessionService = require('../services/botSessionService');
const audioService = require('../services/audioService');
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

    logger.info(`[BotController] Finalizing bot session for meeting ${meetingId}, segments: ${segments?.length || 0}`);

    // Idempotency check: Skip if already processing or completed
    const Meeting = require('../models/Meeting');
    const existingMeeting = await Meeting.findById(meetingId);
    
    if (!existingMeeting) {
      logger.error(`[BotController] Meeting ${meetingId} not found`);
      return res.status(404).json({ success: false, error: 'Meeting not found' });
    }
    
    if (existingMeeting.status === 'completed' || existingMeeting.status === 'processing') {
      logger.info(`[BotController] Meeting ${meetingId} already ${existingMeeting.status}, skipping duplicate finalization`);
      return res.json({ 
        success: true, 
        message: `Already ${existingMeeting.status}`, 
        data: { meetingId } 
      });
    }

    // Update local session
    botSessionService.updateBotSessionStatus(meetingId, 'completed');

    // Respond to Bot service immediately to prevent timeout
    res.json({
      success: true,
      message: 'Bot session finalized, processing started',
      data: { meetingId }
    });

    // Start Asynchronous Processing logic
    setImmediate(async () => {
      try {
        // Use atomic update to prevent version conflicts with concurrent /segments calls
        await Meeting.findByIdAndUpdate(meetingId, {
          status: 'processing',
          processingStage: 'transcribing',
          processingProgress: 60,
          $push: {
            processingLogs: {
              message: 'Memulai pemrosesan audio...',
              timestamp: new Date(),
              stage: 'transcribing'
            }
          }
        });
        
        // Re-fetch meeting to get latest data (including any new segments)
        const meeting = await Meeting.findById(meetingId);
        if (!meeting) throw new Error('Meeting not found after update');
        
        // Notify frontend
        emitBotStatus(meetingId, 'processing', { 
            stage: 'transcribing', 
            message: 'Processing audio chunks...' 
        });

        // 3. Audio Processing DISABLED (text-only mode)
        let processingSuccess = false;
        logger.info(`[BotController] Audio processing disabled - using caption scraping only`);

        // 4. Fallback: Use Scraped Captions if Audio failed
        if (!processingSuccess) {
            logger.warn(`[BotController] Falling back to scraped captions for ${meetingId}`);
            
            const transcriptText = segments?.map(s => `${s.speaker}: ${s.text}`).join('\n') || '';
            
            // Enhance timestamps for scraped segments if missing
            let extractedDuration = 0;
            let lastEnd = 0; // ✅ MOVED: Define BEFORE usage to prevent ReferenceError
            
            const formattedSegments = segments?.map((s, idx) => {
                // Estimate duration based on text length if not provided (avg 15 chars per sec)
                const estimatedDur = Math.max(1, (s.text?.length || 0) / 15);
                const start = s.start || lastEnd;
                const end = s.end || (start + estimatedDur);
                if (end > extractedDuration) extractedDuration = end;
                lastEnd = end; // Update for next iteration
                
                return {
                    speaker: s.speaker || 'Unknown',
                    text: s.text || '',
                    startTime: start,
                    endTime: end,
                };
            }) || [];

            meeting.transcript = transcriptText;
            meeting.segments = formattedSegments;
            if (!meeting.transcription) meeting.transcription = {};
            meeting.transcription.transcript = transcriptText;
            meeting.transcription.segments = formattedSegments.map(s => ({
                start: s.startTime,
                end: s.endTime,
                text: s.text,
                speaker: s.speaker,
            }));
            
            // Calculate Speaker Stats - Use word count as primary metric for scraped captions
            const speakerStats = {};
            let totalWords = 0;
            let totalEstimatedTime = 0;
            
            formattedSegments.forEach(s => {
                const speaker = s.speaker || 'Unknown';
                const wordCount = s.text ? s.text.split(/\s+/).filter(w => w.length > 0).length : 0;
                const segmentDuration = s.endTime - s.startTime;
                // Use actual duration if available, otherwise estimate from word count
                const estimatedTime = segmentDuration > 0.5 ? segmentDuration : Math.max(1, wordCount / 2.5);
                
                if (!speakerStats[speaker]) {
                    speakerStats[speaker] = { words: 0, time: 0, segments: 0 };
                }
                speakerStats[speaker].words += wordCount;
                speakerStats[speaker].time += estimatedTime;
                speakerStats[speaker].segments += 1;
                totalWords += wordCount;
                totalEstimatedTime += estimatedTime;
            });
            
            // Save to analytics with both word-based and time-based percentages
            meeting.analytics = meeting.analytics || {};
            meeting.analytics.speakers = Object.keys(speakerStats).map(spk => ({
                speaker: spk,
                wordCount: speakerStats[spk].words,
                talkTime: Math.round(speakerStats[spk].time),
                segmentCount: speakerStats[spk].segments,
                // Use word-based percentage as primary (more accurate for captions)
                percentage: totalWords > 0 ? Math.round((speakerStats[spk].words / totalWords) * 100) : 0,
                timePercentage: totalEstimatedTime > 0 ? Math.round((speakerStats[spk].time / totalEstimatedTime) * 100) : 0
            }));
            meeting.analytics.totalWords = totalWords;
            meeting.analytics.totalSpeakingTime = Math.round(totalEstimatedTime);
            
            if (!meeting.duration || meeting.duration === 0) meeting.duration = extractedDuration || duration || 60; // fallback

            if (transcriptText) {
                // Trigger AI analysis
                try {
                    const { analyzeTranscript } = require('../services/whisperxService');
                    // Ensure we request specific fields in prompt through the service (handled in service/LLM)
                    const aiResult = await analyzeTranscript(transcriptText);
                    
                    if (aiResult) {
                         if (!meeting.transcription) meeting.transcription = {};
                         // Basic fields
                         meeting.transcription.summary = aiResult.summary || "No summary generated.";
                         if (aiResult.conclusion) meeting.transcription.conclusion = aiResult.conclusion;
                         if (aiResult.highlights) meeting.transcription.highlights = aiResult.highlights;
                         
                         // Action Items & Topics
                         if (aiResult.actionItems) meeting.actionItems = aiResult.actionItems;
                         if (aiResult.action_items) meeting.actionItems = aiResult.action_items;
                         if (aiResult.topics || aiResult.tags) meeting.topics = aiResult.topics || aiResult.tags;
                         
                         // Metadata - Update title if it's a default placeholder
                         const isDefaultTitle = !meeting.title || 
                             meeting.title === 'Untitled Meeting' || 
                             meeting.title === 'Online Meeting';
                         if (isDefaultTitle && aiResult.suggestedTitle) {
                             meeting.title = aiResult.suggestedTitle;
                         }
                         meeting.description = aiResult.suggestedDescription || aiResult.summary || "";
                    }
                } catch (aiErr) {
                    logger.error(`[BotController] AI Analysis failed: ${aiErr.message}`);
                }
            }
            
            // Populate transcription.speakers with calculated stats
            if (typeof speakerStats !== 'undefined' && speakerStats && Object.keys(speakerStats).length > 0) {
               if (!meeting.transcription) meeting.transcription = {};
               meeting.transcription.speakers = Object.keys(speakerStats).map(spk => ({
                   speaker: spk,
                   wordCount: speakerStats[spk].words,
                   talkTime: Math.round(speakerStats[spk].time),
                   segments: speakerStats[spk].segments
               }));
               meeting.transcription.numSpeakers = Object.keys(speakerStats).length;
            }

        }

        // 5. Finalize Meeting Status (use findByIdAndUpdate to prevent version conflicts)
        // IMPORTANT: Include ALL data from meeting object, not just status
        const finalUpdate = {
            status: 'completed',
            processingStage: 'completed',
            processingProgress: 100,
            completedAt: new Date(),
            // Include transcript data
            transcript: meeting.transcript,
            segments: meeting.segments,
            duration: meeting.duration,
            // Include AI analysis results
            transcription: meeting.transcription,
            actionItems: meeting.actionItems,
            topics: meeting.topics,
            analytics: meeting.analytics,
            // Include title/description from AI (if set)
            title: meeting.title,
            description: meeting.description,
            $push: {
                processingLogs: {
                    message: 'Selesai.',
                    timestamp: new Date(),
                    stage: 'completed'
                }
            }
        };

        // Use findByIdAndUpdate instead of save() to avoid version conflicts
        await Meeting.findByIdAndUpdate(meetingId, finalUpdate, { new: true });
        
        // Emit final status to ensure frontend updates
        emitBotStatus(meetingId, 'completed', {
            transcript: meeting.transcript,
            hasAudio: !!meeting.audioUrl
        });

      } catch (asyncError) {
         logger.error(`[BotController] Async finalization fatal error: ${asyncError.message}`);
         // Emit failed status so frontend updates
         emitBotStatus(meetingId, 'failed', { error: asyncError.message });
         
         // Still try to update meeting status in DB
         try {
           const Meeting = require('../models/Meeting');
           await Meeting.findByIdAndUpdate(meetingId, {
             status: 'failed',
             processingStage: 'error',
             $push: { processingLogs: { message: `Error: ${asyncError.message}`, timestamp: new Date(), stage: 'error' } }
           });
         } catch (dbErr) {
           logger.error(`[BotController] Failed to update meeting status: ${dbErr.message}`);
         }
      }
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
