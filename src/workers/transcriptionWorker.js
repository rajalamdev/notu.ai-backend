const Meeting = require('../models/Meeting');
const Task = require('../models/Task');
const { retrieveFile, removeFile, copyToQuarantine } = require('../services/storageService');
const { transcribeAudio, transcribeAudioWithProgress } = require('../services/whisperxService');
const { createTranscriptionWorker } = require('../services/queueService');
const { MEETING_STATUS } = require('../utils/constants');
const { calculateStageProgress, calculateChunkProgress, getStageStartProgress, getStageInfo } = require('../utils/progressUtils');
const logger = require('../utils/logger');
const { normalizeDate } = require('../utils/dateUtils');

// Heartbeat interval in milliseconds
const HEARTBEAT_INTERVAL = 15000; // 15 seconds

// Import socket service for real-time progress updates
let emitToMeeting;
try {
  const socketService = require('../services/socketService');
  emitToMeeting = socketService.emitToMeeting;
} catch (e) {
  logger.warn('Socket service not available for worker progress updates');
  emitToMeeting = () => {};
}

/**
 * Emit transcription progress to socket
 */
function emitProgress(meetingId, progress, message, stage, extra = {}) {
  try {
    if (emitToMeeting) {
      emitToMeeting(meetingId, 'transcription_progress', {
        meetingId,
        progress,
        message,
        stage, // 'downloading', 'transcribing', 'chunk_progress', 'diarization', 'ai_analysis', 'saving', 'completed'
        timestamp: new Date(),
        ...extra
      });
    }
  } catch (e) {
    logger.warn('Failed to emit progress:', e.message);
  }
}

/**
 * Emit heartbeat to indicate worker is still alive
 */
function emitHeartbeat(meetingId, stage, extra = {}) {
  try {
    if (emitToMeeting) {
      emitToMeeting(meetingId, 'worker_heartbeat', {
        meetingId,
        stage,
        timestamp: new Date(),
        ...extra
      });
    }
  } catch (e) {
    // Silent fail for heartbeat
  }
}

/**
 * Start heartbeat interval for a meeting
 * Heartbeat only emits to socket - does NOT save to database to avoid parallel save conflicts
 * @returns {Object} Heartbeat control object
 */
function startHeartbeat(meetingId, initialStage) {
  let currentStage = initialStage;
  
  const sendHeartbeat = () => {
    try {
      emitHeartbeat(String(meetingId), currentStage);
    } catch (e) {
      // Silent fail for heartbeat
    }
  };
  
  // Initial heartbeat
  sendHeartbeat();
  
  // Set interval
  const intervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  
  // Return control object
  return {
    stop: () => clearInterval(intervalId),
    setStage: (stage) => { currentStage = stage; },
  };
}

/**
 * Helper to add a log message to the meeting
 * Ensures log save and WebSocket emit are properly synchronized
 */
async function addProcessingLog(meeting, message, progress = null, stage = null, extra = {}) {
  try {
    const meetingId = meeting._id;
    
    // Use atomic update to avoid parallel save conflicts
    const updateObj = {
      $push: {
        processingLogs: { message, timestamp: new Date(), progress, stage }
      },
      $set: {
        'processingMeta.lastUpdatedAt': new Date(),
      }
    };
    
    if (stage) {
      updateObj.$set['processingMeta.currentStage'] = stage;
    }
    
    await Meeting.findByIdAndUpdate(meetingId, updateObj);
    logger.info(`[Meeting ${meetingId}] LOG: ${message}`);
    
    // Then emit to socket (after save succeeds)
    if (progress !== null) {
      emitProgress(String(meetingId), progress, message, stage, extra);
    }
  } catch (err) {
    logger.error('Error adding processing log:', err);
  }
}

/**
 * Process transcription job
 */
async function processTranscription(job) {
  const { meetingId } = job.data;
  
  logger.info(`Processing transcription job for meeting: ${meetingId}`);
  
  // Heartbeat controller - will be started after meeting is loaded
  let heartbeat = null;
  
  try {
    // Update job progress
    await job.updateProgress(getStageStartProgress('downloading'));

    // Get meeting from database
    const meeting = await Meeting.findById(meetingId);
    
    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }
    
    // Start heartbeat (pass meetingId, not the document to avoid save conflicts)
    heartbeat = startHeartbeat(meetingId, 'starting');

    await addProcessingLog(meeting, 'Memulai proses transkripsi...', getStageStartProgress('downloading'), 'starting');

    // Check if already completed (prevent duplicate processing)
    if (meeting.status === MEETING_STATUS.COMPLETED) {
      logger.warn(`Meeting ${meetingId} already completed, skipping transcription`);
      if (heartbeat) heartbeat.stop();
      return {
        success: true,
        skipped: true,
        message: 'Meeting already transcribed',
      };
    }

    // Populate processingMeta and update status to processing
    meeting.processingMeta = meeting.processingMeta || {};
    meeting.processingMeta.jobId = job.id || `transcription-${meetingId}`;
    meeting.processingMeta.queuedAt = meeting.processingMeta.queuedAt || new Date();
    meeting.processingMeta.processingStartedAt = new Date();
    meeting.processingMeta.lastUpdatedAt = new Date();
    meeting.processingMeta.lastHeartbeat = new Date();
    await meeting.save();
    await meeting.updateStatus(MEETING_STATUS.PROCESSING);
    
    const downloadProgress = getStageStartProgress('downloading');
    await job.updateProgress(downloadProgress);

    // Get file from storage
    heartbeat.setStage('downloading');
    logger.info(`Retrieving file from storage: ${meeting.originalFile.filename}`);
    await addProcessingLog(meeting, 'Mengunduh file audio dari storage...', downloadProgress, 'downloading');
    const fileStream = await retrieveFile(meeting.originalFile.filename);
    
    // Convert stream to buffer for streaming API
    const chunks = [];
    for await (const chunk of fileStream) {
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);
    logger.info(`File downloaded: ${fileBuffer.length} bytes`);
    
    const transcribeProgress = getStageStartProgress('transcribing');
    await job.updateProgress(transcribeProgress);

    // Send to WhisperX API with streaming progress
    heartbeat.setStage('transcribing');
    logger.info(`Sending to WhisperX API for transcription`);
    await addProcessingLog(meeting, 'Memulai transkripsi audio...', transcribeProgress, 'transcribing');
    
    // Progress callback for streaming transcription
    const onTranscriptionProgress = async (stage, progress, message, data = {}) => {
      try {
        const mappedStage = stage === 'ai_analysis' ? 'ai_analysis' : 
                           stage === 'diarization' ? 'diarization' : 
                           stage === 'transcribing' ? 'transcribing' :
                           stage === 'saving' ? 'saving' : 
                           stage === 'completed' ? 'completed' : stage;
        
        // Update heartbeat stage
        if (heartbeat) {
          heartbeat.setStage(mappedStage);
        }
        
        // Use progress directly from Python service (already in correct 20-98 range)
        const actualProgress = progress || transcribeProgress;
        
        // Forward message from Python to frontend via socket
        emitProgress(meetingId, actualProgress, message, mappedStage, {
          chunk: data.chunk,
          totalChunks: data.totalChunks || data.total_chunks,
        });
        
        // Save log to database so frontend can fetch latest message
        await addProcessingLog(meeting, message, actualProgress, mappedStage);
        
        // Update job progress
        if (actualProgress) {
          await job.updateProgress(actualProgress);
        }
        
        // Log chunk progress for debugging
        if (data.chunk && data.totalChunks) {
          logger.info(`Chunk progress: ${data.chunk}/${data.totalChunks} - ${message}`);
          
          // Update chunk info in memory
          meeting.processingMeta.chunkInfo = {
            totalChunks: data.totalChunks,
            currentChunk: data.chunk,
            chunkingEnabled: true,
          };
        }
      } catch (err) {
        logger.warn('Failed to handle transcription progress:', err.message);
      }
    };
    
    const transcriptionResult = await transcribeAudioWithProgress(
      fileBuffer,
      meeting.originalFile.originalName || meeting.originalFile.filename,
      meetingId,
      {
        numSpeakers: 0, // Auto-detect
      },
      onTranscriptionProgress
    );
    
    // Log chunking info if available (Python SSE handles all progress stages now)
    if (transcriptionResult.metadata?.chunking) {
      const chunking = transcriptionResult.metadata.chunking;
      
      // Update chunk info in processing meta (no emit - just update meta)
      meeting.processingMeta.chunkInfo = {
        totalChunks: chunking.total_chunks || 1,
        chunkingEnabled: chunking.chunking_used,
        currentChunk: chunking.total_chunks || 1,
      };
    }
    
    // NOTE: Removed duplicate stage emissions (diarization, ai_analysis, saving)
    // Python SSE stream already emits these stages in real-time
    // Worker only needs to update heartbeat stage for timeout detection
    heartbeat.setStage('saving');

    // Transform speakers array from ["SPEAKER_0"] to [{speaker, start, end}]
    const speakersWithTimestamps = [];
    const segments = transcriptionResult.segments || [];
    const speakersList = transcriptionResult.speakers || [];
    
    // Group segments by speaker and get their time ranges
    for (const speakerId of speakersList) {
      const speakerSegments = segments.filter(seg => seg.speaker === speakerId);
      if (speakerSegments.length > 0) {
        speakersWithTimestamps.push({
          speaker: speakerId,
          start: speakerSegments[0].start,
          end: speakerSegments[speakerSegments.length - 1].end,
        });
      }
    }

    // Update meeting with transcription results
    meeting.transcription = {
      language: transcriptionResult.language,
      transcript: transcriptionResult.transcript,
      segments: segments,
      speakers: speakersWithTimestamps,
      summary: transcriptionResult.summary || '',
      highlights: transcriptionResult.highlights || {}, // Dynamic object with sub-headers
      conclusion: transcriptionResult.conclusion || '',
      diarizationMethod: transcriptionResult.metadata?.diarization_mode || 'light-heuristic',
      numSpeakers: transcriptionResult.metadata?.total_speakers || 0,
      processingTime: transcriptionResult.processingTime,
    };

    // Save a short summary snippet for list previews
    try {
      const snippet = transcriptionResult.summary ? String(transcriptionResult.summary).slice(0, 200) : (transcriptionResult.transcript ? String(transcriptionResult.transcript).slice(0, 200) : '');
      meeting.summarySnippet = snippet;
      meeting.processingMeta = meeting.processingMeta || {};
      meeting.processingMeta.lastUpdatedAt = new Date();
    } catch (e) {
      logger.warn('Could not set summarySnippet:', e);
    }

    // Update title/description if suggested
    if (transcriptionResult.suggestedTitle) {
      meeting.suggestedTitle = transcriptionResult.suggestedTitle;
      // If title is default (likely from filename), suggest one
      const isPlaceholder = !meeting.title || 
        meeting.title.includes('Meeting') || 
        meeting.title.includes('Upload') || 
        meeting.title.includes('video_') || 
        meeting.title.includes('audio_') ||
        (meeting.originalFile?.originalName && meeting.originalFile.originalName.toLowerCase().startsWith(meeting.title.toLowerCase()));

      if (isPlaceholder) {
        meeting.title = transcriptionResult.suggestedTitle;
      }
    }

    if (transcriptionResult.tags && Array.isArray(transcriptionResult.tags)) {
      meeting.tags = transcriptionResult.tags;
    }

    if (transcriptionResult.suggestedDescription) {
      meeting.description = transcriptionResult.suggestedDescription;
    } else if (!meeting.description && transcriptionResult.summary && !transcriptionResult.summary.includes('tidak tersedia')) {
      // Use first paragraph of summary as description
      // Robust markdown stripping: remove bold, italic, headers, list markers
      const firstPara = transcriptionResult.summary.split('\n').find(line => line.trim().length > 0) || '';
      const cleanDesc = firstPara
        .replace(/\*\*/g, '')   // Bold
        .replace(/__/g, '')     // Bold
        .replace(/\*/g, '')     // Italic/List
        .replace(/^#+\s/, '')   // Headers
        .trim();
      
      meeting.description = cleanDesc.slice(0, 500);
    }

    // Process Action Items (Save as Candidates)
    if (transcriptionResult.action_items && Array.isArray(transcriptionResult.action_items)) {
      meeting.actionItems = transcriptionResult.action_items.map(item => {
         // Normalize due date using a central helper. Keep raw value for auditing.
         let norm = normalizeDate(item.dueDate);
         
         // If dueDate is null, try extracting from description
         if (!norm.date && item.description) {
           const descExtract = normalizeDate(item.description);
           if (descExtract.date) {
             norm = descExtract;
           }
         }
         
         // Also try dueDateRaw if provided
         if (!norm.date && item.dueDateRaw) {
           const rawExtract = normalizeDate(item.dueDateRaw);
           if (rawExtract.date) {
             norm = rawExtract;
           }
         }

         return {
           title: item.title || item.text || 'Untitled Task',
           description: item.description || '',
           priority: item.priority || 'medium',
           dueDate: norm.date || null,
           dueDateRaw: norm.raw || item.dueDateRaw || null,
           assigneeName: item.assigneeName,
           labels: item.labels,
           status: 'todo'
         };
      });
    }

    // Calculate participants count from speakers
    if (speakersWithTimestamps.length > 0) {
      meeting.participants = speakersWithTimestamps.length;
    }

    // Set timestamps
    if (!meeting.startedAt) {
      meeting.startedAt = new Date();
    }
    meeting.endedAt = new Date();
    
    // Calculate duration from metadata or top-level response
    const responseDuration = transcriptionResult.metadata?.duration || transcriptionResult.duration;
    if (responseDuration) {
      meeting.duration = Math.ceil(responseDuration);
    }

    // Save all transcription data to MongoDB
    await addProcessingLog(meeting, 'Menyimpan hasil ke database...', 98, 'saving');
    await meeting.save();

    // Stop heartbeat before final status update
    if (heartbeat) heartbeat.stop();
    
    // Small delay to ensure frontend receives final progress before completion
    await new Promise(r => setTimeout(r, 300));

    // Update status to completed
    await addProcessingLog(meeting, '✅ Selesai! Semua data berhasil diproses.', 100, 'completed');
    await meeting.updateStatus(MEETING_STATUS.COMPLETED);
    await job.updateProgress(100);
    
    // Emit completion event
    emitProgress(meetingId, 100, 'Transkripsi selesai!', 'completed');
    try {
      if (emitToMeeting) {
        emitToMeeting(meetingId, 'transcription_complete', { meetingId });
      }
    } catch (e) {}

    logger.info(`Transcription completed successfully for meeting: ${meetingId}`);
    
    return {
      success: true,
      meetingId,
      transcriptionLength: transcriptionResult.transcript?.length || 0,
      segmentsCount: transcriptionResult.segments?.length || 0,
    };

  } catch (error) {
    // Stop heartbeat on error
    if (heartbeat) heartbeat.stop();
    
    logger.error(`Transcription job failed for meeting ${meetingId}:`, error);

    // Emit failure event
    try {
      if (emitToMeeting) {
        emitToMeeting(meetingId, 'transcription_failed', { meetingId, error: error.message });
      }
    } catch (e) {}

    // Update meeting with error
    try {
      const meeting = await Meeting.findById(meetingId);
      if (meeting) {
        await addProcessingLog(meeting, `❌ Error: ${error.message}`, null, 'error');
        await meeting.incrementRetry();
        
        // If max retries reached, mark as failed and cleanup MinIO
        if (meeting.retryCount >= 3) {
          await addProcessingLog(meeting, 'Gagal memproses setelah beberapa percobaan.');
          await meeting.updateStatus(MEETING_STATUS.FAILED, error.message);

          // Move file to quarantine instead of immediate deletion to preserve for debugging
          if (meeting.originalFile && meeting.originalFile.filename) {
            try {
              const qname = await copyToQuarantine(meeting.originalFile.filename);
              logger.info(`Moved failed meeting file to quarantine: ${qname}`);
              // Optionally update meeting record with quarantine path
              meeting.processingMeta = meeting.processingMeta || {};
              meeting.processingMeta.quarantinePath = qname;
              await meeting.save();
            } catch (cleanupError) {
              logger.error('Error moving file to quarantine:', cleanupError);
            }
          }
        }
      }
    } catch (updateError) {
      logger.error('Error updating meeting status:', updateError);
    }

    throw error;
  }
}
/**
 * Start the transcription worker
 */
function startTranscriptionWorker() {
  const worker = createTranscriptionWorker(processTranscription);
  
  logger.info('Transcription worker started and listening for jobs');
  
  // Graceful shutdown handler
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down transcription worker gracefully...');
    try {
      await worker.close();
      logger.info('Worker closed successfully');
      process.exit(0);
    } catch (error) {
      logger.error('Error during worker shutdown:', error);
      process.exit(1);
    }
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down transcription worker gracefully...');
    try {
      await worker.close();
      logger.info('Worker closed successfully');
      process.exit(0);
    } catch (error) {
      logger.error('Error during worker shutdown:', error);
      process.exit(1);
    }
  });
  
  return worker;
}

module.exports = {
  processTranscription,
  startTranscriptionWorker,
};
