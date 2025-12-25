const Meeting = require('../models/Meeting');
const Task = require('../models/Task');
const { retrieveFile, removeFile, copyToQuarantine } = require('../services/storageService');
const { transcribeAudio } = require('../services/whisperxService');
const { createTranscriptionWorker } = require('../services/queueService');
const { MEETING_STATUS } = require('../utils/constants');
const logger = require('../utils/logger');

/**
 * Process transcription job
 */
async function processTranscription(job) {
  const { meetingId } = job.data;
  
  logger.info(`Processing transcription job for meeting: ${meetingId}`);
  
  try {
    // Update job progress
    await job.updateProgress(10);

    // Get meeting from database
    const meeting = await Meeting.findById(meetingId);
    
    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    // Check if already completed (prevent duplicate processing)
    if (meeting.status === MEETING_STATUS.COMPLETED) {
      logger.warn(`Meeting ${meetingId} already completed, skipping transcription`);
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
    await meeting.save();
    await meeting.updateStatus(MEETING_STATUS.PROCESSING);
    await job.updateProgress(20);

    // Get file from storage
    logger.info(`Retrieving file from storage: ${meeting.originalFile.filename}`);
    const fileStream = await retrieveFile(meeting.originalFile.filename);
    await job.updateProgress(30);

    // Send to WhisperX API (removed unused diarizationMethod parameter)
    logger.info(`Sending to WhisperX API for transcription`);
    const transcriptionResult = await transcribeAudio(
      fileStream,
      meeting.originalFile.originalName || meeting.originalFile.filename,
      meetingId,
      {
        numSpeakers: 0, // Auto-detect
        enableSummary: true,
      }
    );
    await job.updateProgress(90);

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

    // Create tasks from action items (save to Task collection)
    if (transcriptionResult.action_items && Array.isArray(transcriptionResult.action_items) && transcriptionResult.action_items.length > 0) {
      const tasksToCreate = transcriptionResult.action_items.map((item, index) => {
        // Parse dueDate if it's a string
        let parsedDueDate = undefined
        if (item.dueDate) {
          // Try to parse date strings like "Besok", "Minggu depan", or date formats
          const dueDateStr = String(item.dueDate).toLowerCase()
          const now = new Date()
          
          if (dueDateStr.includes('besok') || dueDateStr.includes('tomorrow')) {
            parsedDueDate = new Date(now.getTime() + 24 * 60 * 60 * 1000)
          } else if (dueDateStr.includes('minggu depan') || dueDateStr.includes('next week')) {
            parsedDueDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
          } else if (dueDateStr.includes('lusa')) {
            parsedDueDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000)
          } else {
            // Try to parse as date
            try {
              parsedDueDate = new Date(item.dueDate)
              if (isNaN(parsedDueDate.getTime())) {
                parsedDueDate = undefined
              }
            } catch {
              parsedDueDate = undefined
            }
          }
        }
        
        return {
          userId: meeting.userId, // Link to meeting owner
          meetingId: meeting._id, // Reference to source meeting
          source: 'ai', // Mark as AI-generated
          title: item.title || item.text || 'Untitled Task',
          description: item.description || '',
          assignee: null, // Always null from AI, will be assigned via UI
          assigneeName: item.assigneeName || '', // Store name if mentioned
          priority: item.priority || 'medium',
          dueDate: parsedDueDate,
          status: 'todo', // Always start as todo
          labels: item.labels || [],
          order: index, // Preserve order from AI
        }
      })
      
      // Bulk insert tasks
      try {
        const createdTasks = await Task.insertMany(tasksToCreate)
        logger.info(`Created ${createdTasks.length} tasks from AI extraction for meeting ${meetingId}`)
      } catch (taskError) {
        logger.error(`Failed to create tasks for meeting ${meetingId}:`, taskError)
        // Don't throw - transcription still succeeded, just log the error
      }
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
    
    // Calculate duration from metadata if available
    if (transcriptionResult.metadata && transcriptionResult.metadata.duration) {
      meeting.duration = Math.ceil(transcriptionResult.metadata.duration);
    }

    // Save all transcription data to MongoDB
    await meeting.save();

    // Update status to completed
    await meeting.updateStatus(MEETING_STATUS.COMPLETED);
    await job.updateProgress(100);

    logger.info(`Transcription completed successfully for meeting: ${meetingId}`);
    
    return {
      success: true,
      meetingId,
      transcriptionLength: transcriptionResult.transcript?.length || 0,
      segmentsCount: transcriptionResult.segments?.length || 0,
    };

  } catch (error) {
    logger.error(`Transcription job failed for meeting ${meetingId}:`, error);

    // Update meeting with error
    try {
      const meeting = await Meeting.findById(meetingId);
      if (meeting) {
        await meeting.incrementRetry();
        
        // If max retries reached, mark as failed and cleanup MinIO
        if (meeting.retryCount >= 3) {
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
