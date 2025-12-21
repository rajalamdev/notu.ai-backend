const Meeting = require('../models/Meeting');
const Task = require('../models/Task');
const { removeFile, getFileUrl } = require('../services/storageService');
const { getJobStatus } = require('../services/queueService');
const { MEETING_STATUS, MEETING_TYPE, PLATFORM } = require('../utils/constants');
const config = require('../config/env');
const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Get all meetings with pagination
 */
async function getAllMeetings(req, res, next) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;
    const status = req.query.status;
    const type = req.query.type;
    const search = req.query.search;

    // Build query - filter by user if authenticated
    const query = {};
    if (req.user && req.user.id) {
      query.userId = req.user.id;
    }
    if (status) query.status = status;
    if (type) query.type = type;
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search, 'i')] } },
      ];
    }

    // Get meetings
    const meetings = await Meeting.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-transcription.segments'); // Exclude segments for list view

    const total = await Meeting.countDocuments(query);

    res.json({
      success: true,
      meetings,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Error getting meetings:', error);
    next(error);
  }
}

/**
 * Get meeting by ID
 */
async function getMeetingById(req, res, next) {
  try {
    const { id } = req.params;

    const meeting = await Meeting.findById(id);

    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Meeting not found',
      });
    }

    // Get file URL if file exists
    let fileUrl = null;
    if (meeting.originalFile && meeting.originalFile.filename) {
      try {
        fileUrl = await getFileUrl(meeting.originalFile.filename, 3600);
      } catch (error) {
        logger.warn(`Could not generate file URL for ${meeting.originalFile.filename}`);
      }
    }

    // Get action items from Task collection
    const actionItems = await Task.find({ meetingId: id })
      .sort({ order: 1, createdAt: 1 })
      .populate('assignee', 'name email');

    res.json({
      success: true,
      meeting,
      actionItems, // Action items from Task collection
      fileUrl,
    });
  } catch (error) {
    logger.error('Error getting meeting:', error);
    next(error);
  }
}

/**
 * Get meeting status (for polling)
 */
async function getMeetingStatus(req, res, next) {
  try {
    const { id } = req.params;

    const meeting = await Meeting.findById(id).select('status errorMessage retryCount');

    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Meeting not found',
      });
    }

    // Get job status from queue
    const jobId = `transcription-${id}`;
    const jobStatus = await getJobStatus(jobId);

    res.json({
      success: true,
      data: {
        meetingId: id,
        status: meeting.status,
        errorMessage: meeting.errorMessage,
        retryCount: meeting.retryCount,
        job: jobStatus,
      },
    });
  } catch (error) {
    logger.error('Error getting meeting status:', error);
    next(error);
  }
}

/**
 * Update meeting
 */
async function updateMeeting(req, res, next) {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Get meeting first to handle nested updates
    const meeting = await Meeting.findById(id);
    
    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Meeting not found',
      });
    }

    // Only allow updating certain fields
    const allowedUpdates = ['title', 'description', 'tags', 'isPublic'];
    const updateData = {};
    
    allowedUpdates.forEach((field) => {
      if (updates[field] !== undefined) {
        updateData[field] = updates[field];
      }
    });
    
    // Handle transcription updates (executiveSummary, highlights, conclusion)
    if (updates.executiveSummary !== undefined || updates.highlights !== undefined || updates.conclusion !== undefined) {
      if (!meeting.transcription) {
        meeting.transcription = {};
      }
      
      if (updates.executiveSummary !== undefined) {
        meeting.transcription.summary = updates.executiveSummary;
      }
      if (updates.highlights !== undefined) {
        meeting.transcription.highlights = updates.highlights;
      }
      if (updates.conclusion !== undefined) {
        meeting.transcription.conclusion = updates.conclusion;
      }
      
      updateData.transcription = meeting.transcription;
    }
    
    // Note: actionItems are now managed via Task collection
    // Use /api/tasks endpoint to create/update tasks

    const updatedMeeting = await Meeting.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    res.json({
      success: true,
      message: 'Meeting updated successfully',
      data: updatedMeeting,
    });
  } catch (error) {
    logger.error('Error updating meeting:', error);
    next(error);
  }
}

/**
 * Delete meeting
 */
async function deleteMeeting(req, res, next) {
  try {
    const { id } = req.params;

    const meeting = await Meeting.findById(id);

    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Meeting not found',
      });
    }

    // Delete file from MinIO if exists
    if (meeting.originalFile && meeting.originalFile.filename) {
      try {
        await removeFile(meeting.originalFile.filename);
        logger.info(`Deleted file from storage: ${meeting.originalFile.filename}`);
      } catch (error) {
        logger.warn(`Could not delete file: ${meeting.originalFile.filename}`, error);
      }
    }

    // Delete meeting from database
    await Meeting.findByIdAndDelete(id);

    res.json({
      success: true,
      message: 'Meeting deleted successfully',
    });
  } catch (error) {
    logger.error('Error deleting meeting:', error);
    next(error);
  }
}

/**
 * Export transcript as plain text, or download original file (mp3/mp4)
 */
async function exportTranscript(req, res, next) {
  try {
    const { id } = req.params;
    const format = req.query.format || 'txt';

    const meeting = await Meeting.findById(id);

    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Meeting not found',
      });
    }

    // Handle file download (mp3, mp4)
    if (format === 'mp3' || format === 'mp4') {
      if (!meeting.originalFile || !meeting.originalFile.filename) {
        return res.status(404).json({
          success: false,
          error: 'File Not Found',
          message: 'Original file not available',
        });
      }

      // Check if file type matches requested format
      const mimetype = meeting.originalFile.mimetype || '';
      const isVideo = mimetype.startsWith('video/') || meeting.originalFile.originalName?.toLowerCase().endsWith('.mp4');
      const isAudio = mimetype.startsWith('audio/') || meeting.originalFile.originalName?.toLowerCase().match(/\.(mp3|m4a|wav)$/);

      if (format === 'mp4' && !isVideo) {
        return res.status(400).json({
          success: false,
          error: 'Invalid Format',
          message: 'This meeting does not have a video file',
        });
      }

      if (format === 'mp3' && !isAudio) {
        return res.status(400).json({
          success: false,
          error: 'Invalid Format',
          message: 'This meeting does not have an audio file',
        });
      }

      try {
        const { getFileStream } = require('../services/storageService');
        const fileStream = await getFileStream(meeting.originalFile.filename);
        const extension = meeting.originalFile.originalName?.split('.').pop() || format;
        const contentType = meeting.originalFile.mimetype || (format === 'mp3' ? 'audio/mpeg' : 'video/mp4');
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${meeting.title || 'meeting'}.${extension}"`);
        fileStream.pipe(res);
        return;
      } catch (error) {
        logger.error('Error streaming file:', error);
        return res.status(500).json({
          success: false,
          error: 'File Stream Error',
          message: 'Could not stream file',
        });
      }
    }

    // Handle text export
    if (meeting.status !== MEETING_STATUS.COMPLETED || !meeting.transcription) {
      return res.status(400).json({
        success: false,
        error: 'Transcription Not Available',
        message: 'Transcription is not yet available for this meeting',
      });
    }

    // Format transcript
    let transcript = `Meeting: ${meeting.title}\n`;
    transcript += `Date: ${meeting.createdAt.toLocaleDateString()}\n`;
    if (meeting.description) {
      transcript += `Description: ${meeting.description}\n`;
    }
    transcript += `\n--- TRANSCRIPT ---\n\n`;
    
    if (meeting.transcription.segments && meeting.transcription.segments.length > 0) {
      meeting.transcription.segments.forEach((segment) => {
        const hours = Math.floor(segment.start / 3600);
        const minutes = Math.floor((segment.start % 3600) / 60);
        const seconds = Math.floor(segment.start % 60);
        const timeStr = hours > 0 
          ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
          : `${minutes}:${seconds.toString().padStart(2, '0')}`;
        transcript += `[${timeStr}] ${segment.speaker}: ${segment.text}\n`;
      });
    } else {
      transcript += meeting.transcription.transcript || 'No transcript available';
    }

    if (meeting.transcription.summary) {
      transcript += `\n\n--- SUMMARY ---\n\n${meeting.transcription.summary}`;
    }

    if (meeting.actionItems && meeting.actionItems.length > 0) {
      transcript += `\n\n--- ACTION ITEMS ---\n\n`;
      meeting.actionItems.forEach((item, index) => {
        transcript += `${index + 1}. ${item.text}`;
        if (item.assignee) transcript += ` (Assignee: ${item.assignee})`;
        if (item.dueDate) transcript += ` (Due: ${new Date(item.dueDate).toLocaleDateString()})`;
        transcript += `\n`;
      });
    }

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="transcript-${id}.txt"`);
    res.send(transcript);
  } catch (error) {
    logger.error('Error exporting transcript:', error);
    next(error);
  }
}

/**
 * Get meeting analytics (talktime, topics/keywords)
 * GET /api/meetings/:id/analytics
 */
async function getMeetingAnalytics(req, res, next) {
  try {
    const { id } = req.params;

    const meeting = await Meeting.findById(id);

    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Meeting not found',
      });
    }

    if (!meeting.transcription || !meeting.transcription.segments) {
      return res.json({
        success: true,
        data: {
          talkTime: [],
          topics: [],
        },
      });
    }

    // Calculate talk time per speaker
    const talkTimeMap = {};
    const segments = meeting.transcription.segments || [];
    
    if (segments.length === 0) {
      return res.json({
        success: true,
        data: {
          talkTime: [],
          topics: [],
          actionItems: meeting.actionItems || [],
        },
      });
    }
    
    segments.forEach((segment) => {
      const speaker = segment.speaker || 'SPEAKER_0';
      if (!talkTimeMap[speaker]) {
        talkTimeMap[speaker] = {
          speaker,
          words: 0,
          talks: 0,
          totalDuration: 0,
        };
      }
      const wordCount = segment.text ? segment.text.trim().split(/\s+/).filter(w => w.length > 0).length : 0;
      talkTimeMap[speaker].words += wordCount;
      talkTimeMap[speaker].talks += 1;
      talkTimeMap[speaker].totalDuration += (segment.end - segment.start);
    });

    // Calculate total duration and percentages
    const totalDuration = meeting.duration || (segments.length > 0 ? segments[segments.length - 1].end : 1);
    const totalTalkDuration = Object.values(talkTimeMap).reduce((sum, item) => sum + item.totalDuration, 0);
    
    const talkTime = Object.values(talkTimeMap)
      .map((item) => ({
        speaker: item.speaker,
        words: item.words,
        talks: item.talks,
        total: totalTalkDuration > 0 ? Math.round((item.totalDuration / totalTalkDuration) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total); // Sort by percentage descending

    // Extract topics/keywords from tags and transcript
    const topics = [];
    if (meeting.tags && meeting.tags.length > 0) {
      meeting.tags.forEach((tag, index) => {
        const colors = ['bg-purple-500', 'bg-emerald-500', 'bg-gray-400', 'bg-red-400', 'bg-orange-400'];
        topics.push({
          name: tag,
          color: colors[index % colors.length],
        });
      });
    }

    // Extract keywords from transcript if no tags
    if (topics.length === 0 && meeting.transcription.transcript) {
      const commonWords = meeting.transcription.transcript
        .toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 4)
        .reduce((acc, word) => {
          acc[word] = (acc[word] || 0) + 1;
          return acc;
        }, {});
      
      const topWords = Object.entries(commonWords)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([word], index) => {
          const colors = ['bg-purple-500', 'bg-emerald-500', 'bg-gray-400', 'bg-red-400', 'bg-orange-400'];
          return {
            name: word.charAt(0).toUpperCase() + word.slice(1),
            color: colors[index % colors.length],
          };
        });
      
      topics.push(...topWords);
    }

    res.json({
      success: true,
      data: {
        talkTime,
        topics,
        actionItems: meeting.actionItems || [],
      },
    });
  } catch (error) {
    logger.error('Error getting meeting analytics:', error);
    next(error);
  }
}

module.exports = {
  getAllMeetings,
  getMeetingById,
  getMeetingStatus,
  updateMeeting,
  deleteMeeting,
  exportTranscript,
  createMeeting,
  createOnlineMeeting,
  retryTranscription,
  getMeetingAnalytics,
};

/**
 * Create a new meeting
 * POST /api/meetings
 */
async function createMeeting(req, res, next) {
  try {
    const { title, description, type, platform, meetingLink, scheduledAt, tags } = req.body;
    
    if (!title) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Title is required',
      });
    }
    
    const meeting = await Meeting.create({
      userId: req.user.id,
      title,
      description,
      type: type || MEETING_TYPE.UPLOAD,
      platform: platform || PLATFORM.UPLOAD,
      meetingLink,
      scheduledAt,
      tags: tags || [],
      status: MEETING_STATUS.PENDING,
    });
    
    logger.info(`Meeting created: ${meeting._id} by user ${req.user.id}`);
    
    res.status(201).json({
      success: true,
      message: 'Meeting created successfully',
      data: meeting,
    });
  } catch (error) {
    logger.error('Error creating meeting:', error);
    next(error);
  }
}

/**
 * Create online meeting and start bot
 * POST /api/meetings/online
 */
async function createOnlineMeeting(req, res, next) {
  try {
    const { title, meetingLink, platform, duration } = req.body;
    
    if (!title || !meetingLink) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Title and meeting link are required',
      });
    }
    
    // Detect platform from URL
    let detectedPlatform = platform || PLATFORM.OTHER;
    if (meetingLink.includes('meet.google.com')) {
      detectedPlatform = PLATFORM.GOOGLE_MEET;
    } else if (meetingLink.includes('zoom.us')) {
      detectedPlatform = PLATFORM.ZOOM;
    } else if (meetingLink.includes('teams.microsoft')) {
      detectedPlatform = PLATFORM.TEAMS;
    }
    
    // Create meeting
    const meeting = await Meeting.create({
      userId: req.user.id,
      title,
      meetingLink,
      platform: detectedPlatform,
      type: MEETING_TYPE.ONLINE,
      status: MEETING_STATUS.PENDING,
      startedAt: new Date(),
    });
    
    logger.info(`Online meeting created: ${meeting._id}`);
    
    // Try to start bot service
    let botResponse = null;
    try {
      const botServiceUrl = config.BOT_SERVICE_URL || 'http://localhost:3001';
      const response = await axios.post(`${botServiceUrl}/api/bot/join`, {
        meetingUrl: meetingLink,
        meetingId: meeting._id.toString(),
        duration: duration || 60, // Default 60 minutes
      }, {
        timeout: 10000, // 10 second timeout
      });
      
      botResponse = response.data;
      meeting.status = MEETING_STATUS.PROCESSING;
      await meeting.save();
      
      logger.info(`Bot joined meeting: ${meeting._id}`);
    } catch (botError) {
      logger.warn(`Bot service unavailable or failed: ${botError.message}`);
      // Don't fail the request, just note the bot is unavailable
    }
    
    res.status(201).json({
      success: true,
      message: botResponse ? 'Meeting created and bot started' : 'Meeting created (bot unavailable)',
      data: {
        meeting,
        bot: botResponse,
      },
    });
  } catch (error) {
    logger.error('Error creating online meeting:', error);
    next(error);
  }
}

/**
 * Retry failed transcription
 * POST /api/meetings/:id/retry
 */
async function retryTranscription(req, res, next) {
  try {
    const { id } = req.params;
    
    const meeting = await Meeting.findOne({
      _id: id,
      userId: req.user.id,
    });
    
    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Meeting not found',
      });
    }
    
    if (meeting.status !== MEETING_STATUS.FAILED) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Only failed meetings can be retried',
      });
    }
    
    // Reset meeting status
    meeting.status = MEETING_STATUS.PENDING;
    meeting.errorMessage = null;
    meeting.retryCount = (meeting.retryCount || 0) + 1;
    await meeting.save();
    
    // Re-queue for transcription if file exists
    if (meeting.originalFile && meeting.originalFile.filename) {
      const { addTranscriptionJob } = require('../services/queueService');
      await addTranscriptionJob({
        meetingId: meeting._id.toString(),
        filename: meeting.originalFile.filename,
      });
    }
    
    logger.info(`Retry transcription for meeting: ${meeting._id}`);
    
    res.json({
      success: true,
      message: 'Transcription retry initiated',
      data: meeting,
    });
  } catch (error) {
    logger.error('Error retrying transcription:', error);
    next(error);
  }
}
