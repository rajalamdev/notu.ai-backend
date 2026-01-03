const mongoose = require('mongoose');
const Meeting = require('../models/Meeting');
const Task = require('../models/Task');
const Board = require('../models/Board');
const ChatMessage = require('../models/ChatMessage');
const { removeFile, getFileUrl } = require('../services/storageService');
const { getJobStatus } = require('../services/queueService');
const { emitToMeeting, emitMeetingContentUpdated, emitMeetingActionItemSynced, emitMeetingAiRegenerated } = require('../services/socketService');
const crypto = require('crypto');
const nanoid = (size = 10) => crypto.randomBytes(size).toString('hex').slice(0, size);
const { MEETING_STATUS, MEETING_TYPE, PLATFORM, COLLABORATOR_ROLES } = require('../utils/constants');
const config = require('../config/env');
const axios = require('axios');
const logger = require('../utils/logger');
const { normalizeDate, extractDateFromText } = require('../utils/dateUtils');
const { idEquals } = require('../utils/idEquals');
const { getResourcePermission } = require('../utils/permissions');
const User = require('../models/User');

/**
 * Helper to add a log message to the meeting
 */
async function addProcessingLog(meeting, message) {
  try {
    meeting.processingLogs = meeting.processingLogs || [];
    meeting.processingLogs.push({ message, timestamp: new Date() });
    await meeting.save();
    logger.info(`[Meeting ${meeting._id}] LOG: ${message}`);
  } catch (err) {
    logger.error('Error adding processing log:', err);
  }
}

/**
 * Helper to calculate meeting analytics
 */
function calculateAnalytics(meeting) {
  if (!meeting || !meeting.transcription || !meeting.transcription.segments || meeting.transcription.segments.length === 0) {
    return {
      talkTime: [],
      topics: [],
    };
  }

  const talkTimeMap = {};
  const segments = meeting.transcription.segments;
  
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

  const totalTalkDuration = Object.values(talkTimeMap).reduce((sum, item) => sum + item.totalDuration, 0);
  
  const talkTime = Object.values(talkTimeMap)
    .map((item) => ({
      speaker: item.speaker,
      words: item.words,
      talks: item.talks,
      total: totalTalkDuration > 0 ? Math.round((item.totalDuration / totalTalkDuration) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const topics = [];
  if (meeting.tags && meeting.tags.length > 0) {
    meeting.tags.forEach((tag, index) => {
      const colors = ['bg-purple-500', 'bg-emerald-500', 'bg-indigo-500', 'bg-rose-500', 'bg-amber-500'];
      topics.push({
        name: tag,
        color: colors[index % colors.length],
      });
    });
  } else if (meeting.transcription && meeting.transcription.summary) {
    // Fallback: extract some keywords from summary if tags are missing (for old data)
    const keywords = meeting.transcription.summary
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 5 && !['adalah', 'dengan', 'bahwa', 'selanjutnya'].includes(w))
      .slice(0, 5);
    
    keywords.forEach((tag, index) => {
      const colors = ['bg-purple-500', 'bg-emerald-500', 'bg-indigo-500', 'bg-rose-500', 'bg-amber-500'];
      topics.push({
        name: tag.charAt(0).toUpperCase() + tag.slice(1),
        color: colors[index % colors.length],
      });
    });
  }

  return { talkTime, topics };
}

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
    // Exclude soft-deleted meetings by default (treat missing field as not deleted)
    query.deleted = { $ne: true };
    if (req.user && req.user.id) {
      const filter = req.query.filter || 'all';
      
      if (filter === 'mine') {
        query.userId = req.user.id;
      } else if (filter === 'shared') {
        query['collaborators.user'] = req.user.id;
        query.userId = { $ne: req.user.id }; // Ensure not owner
      } else {
        query.$or = [
          { userId: req.user.id },
          { 'collaborators.user': req.user.id }
        ];
      }
    }

    if (status) query.status = status;
    if (type) {
      // support comma-separated list of types (e.g. "online,realtime")
      if (typeof type === 'string' && type.includes(',')) {
        const types = type.split(',').map(t => t.trim()).filter(Boolean);
        if (types.length) query.type = { $in: types };
      } else {
        query.type = type;
      }
    }
    if (search) {
      const searchOr = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search, 'i')] } },
      ];

      // If we already have an ownership $or (owner/shared), combine using $and
      if (query.$or && Array.isArray(query.$or) && query.$or.length) {
        query.$and = [{ $or: query.$or }, { $or: searchOr }];
        delete query.$or;
      } else {
        query.$or = searchOr;
      }
    }

    // Get meetings (list view: include only small, necessary fields)
    const meetings = await Meeting.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('title suggestedTitle type status platform description tags createdAt updatedAt userId isPublic collaborators processingLogs processingMeta duration participants originalFile'); // include status, platform, logs for status page

    const total = await Meeting.countDocuments(query);

    // Gather action item counts and board existence for the current page of meetings
    const meetingIds = meetings.map(m => m._id);

    const actionAgg = await Task.aggregate([
      { $match: { meetingId: { $in: meetingIds } } },
      { $group: { _id: '$meetingId', count: { $sum: 1 } } }
    ]);
    const actionMap = actionAgg.reduce((acc, cur) => (acc.set(String(cur._id), cur.count), acc), new Map());

    const boardAgg = await Board.aggregate([
      { $match: { meetingId: { $in: meetingIds } } },
      { $group: { _id: '$meetingId', count: { $sum: 1 } } }
    ]);
    const boardMap = boardAgg.reduce((acc, cur) => (acc.set(String(cur._id), cur.count), acc), new Map());

    // Map meetings to include lightweight derived fields for frontend
    const mapped = meetings.map((m) => {
      const obj = m.toObject();

      // Canonicalize title: prefer explicit title, fall back to suggestedTitle
      const title = obj.title || obj.suggestedTitle || 'Untitled Meeting';

      const currentUserId = req.user?.id || req.user?._id;
      
      // Use centralized permission helper for consistent role detection
      const permission = getResourcePermission(obj, currentUserId);

      const actionCount = actionMap.get(String(obj._id)) || 0;
      const hasBoard = (boardMap.get(String(obj._id)) || 0) > 0;

      // Get latest progress from logs
      const latestLog = obj.processingLogs && obj.processingLogs.length > 0 
        ? obj.processingLogs[obj.processingLogs.length - 1] 
        : null;

      return {
        _id: obj._id,
        title,
        type: obj.type || 'upload',
        status: obj.status || 'pending',
        platform: obj.platform || 'Upload',
        description: obj.description || '',
        tags: obj.tags || [],
        createdAt: obj.createdAt,
        updatedAt: obj.updatedAt,
        userId: obj.userId,
        isPublic: obj.isPublic || false,
        isOwner: permission.isOwner,
        isCollaborator: permission.canView && !permission.isOwner,
        userRole: permission.role || 'viewer',
        canEdit: permission.canEdit,
        canDelete: permission.canDelete,
        canManageCollaborators: permission.canManageCollaborators,
        actionItemCount: actionCount,
        hasBoard,
        duration: obj.duration || 0,
        participants: obj.participants || 0,
        originalFilename: obj.originalFile?.originalName || '',
        processingLogs: obj.processingLogs || [],
        processingProgress: latestLog?.progress || 0,
        processingStage: latestLog?.stage || null,
      };
    });

    res.json({
      success: true,
      meetings: mapped,
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

    // Fetch meeting without populating collaborators first so we can perform
    // access checks against raw ObjectId values (populate may replace ids with null)
    const meeting = await Meeting.findById(id);

    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Meeting not found',
      });
    }

    // Backup raw userId for permission checks and fallback
    const rawUserId = meeting.userId ? String(meeting.userId) : null;
    // Backup raw collaborators (ids + role) before populate in case populate returns null
    const rawCollaborators = Array.isArray(meeting.collaborators)
      ? meeting.collaborators.map(c => ({ user: c.user, role: c.role, joinedAt: c.joinedAt }))
      : [];

    // Check access using idEquals to handle populated docs and raw ObjectIds
    const currentUserId = req.user?.id || req.user?._id;
    const isPublic = meeting.isPublic === true;

    const hasOwnerRole = meeting.collaborators && Array.isArray(meeting.collaborators) && meeting.collaborators.some(c => c && c.role === COLLABORATOR_ROLES.OWNER && currentUserId && idEquals(c.user, currentUserId));
    const isOwner = !!(currentUserId && (idEquals(meeting.userId, currentUserId) || hasOwnerRole));

    // Resolve collaborators from raw values in the document (these may be ObjectIds or populated docs)
    const isCollaborator = meeting.collaborators && meeting.collaborators.some(c => {
      if (!c || !c.user) return false;
      return !!(currentUserId && idEquals(c.user, currentUserId));
    });

    if (!isOwner && !isCollaborator && !isPublic) {
      logger.warn(`Access denied for user ${currentUserId} to meeting ${id}. Owner: ${rawUserId}, Public: ${isPublic}`);
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'You do not have permission to access this meeting',
      });
    }

    // Role for current user
    let userRole = 'viewer';
    if (isOwner) userRole = 'owner';
    else if (isCollaborator) {
      const col = meeting.collaborators.find(c => {
        if (!c || !c.user) return false;
        return currentUserId && idEquals(c.user, currentUserId);
      });
      userRole = col?.role || 'viewer';
    }

    // Populate userId and collaborators for response (after access checks)
    await meeting.populate('userId', 'name email image');
    await meeting.populate('collaborators.user', 'name email image');

    // Get file URL if file exists
    let fileUrl = null;
    if (meeting.originalFile && meeting.originalFile.filename) {
      try {
        fileUrl = await getFileUrl(meeting.originalFile.filename, 3600);
      } catch (error) {
        logger.warn(`Could not generate file URL for ${meeting.originalFile.filename}`);
      }
    }

    // Unified Action Items logic
    const tasks = await Task.find({ meetingId: id })
      .sort({ order: 1, createdAt: -1 })
      .populate('assignee', 'name email');

    // Check if a Kanban board exists for this meeting (may be created but tasks not migrated)
    let board = await Board.findOne({ meetingId: id }).select('_id userId');
    const hasBoard = !!board;

    // Calculate analytics on the fly
    const analytics = calculateAnalytics(meeting);

    // Prune redundant data for response
    const meetingObj = meeting.toObject();
    
    // 1. Remove summarySnippet (redundant with full summary on detail page)
    delete meetingObj.summarySnippet;
    
    // 2. Clear logs if completed (keep response clean unless requested)
    if (meeting.status === MEETING_STATUS.COMPLETED && !req.query.includeLogs) {
      delete meetingObj.processingLogs;
    }

    // 3. Simplify originalFile
    if (meetingObj.originalFile) {
        delete meetingObj.originalFile.path;
    }

    // 4. Fallback for userId if populate failed or user was null
    if (!meetingObj.userId && rawUserId) {
        const isSelf = currentUserId === rawUserId;
        meetingObj.userId = { 
          _id: rawUserId, 
          name: isSelf ? (req.user?.name || 'Anda') : 'Original Owner',
          image: isSelf ? req.user?.image : null
        };
    }

    // Ensure collaborators array is safe for the frontend. Use raw collaborator ids as fallback
    const populatedCollabs = Array.isArray(meeting.collaborators) ? meeting.collaborators : [];
    let finalCollaborators = (rawCollaborators || []).map((raw) => {
      // Try to find the populated user matching this raw id
      const populatedEntry = populatedCollabs.find(pc => pc && pc.user && idEquals(pc.user, raw.user));
      const userObj = populatedEntry && populatedEntry.user
        ? { _id: populatedEntry.user._id ? String(populatedEntry.user._id) : String(populatedEntry.user), name: populatedEntry.user.name || 'Unknown', image: populatedEntry.user.image || null }
        : { _id: raw.user ? String(raw.user) : null, name: 'Unknown', image: null };

      return {
        user: userObj,
        role: raw.role || COLLABORATOR_ROLES.VIEWER,
        joinedAt: raw.joinedAt || null,
      };
    });

    // Fill missing names/images by querying User collection once for any collaborator lacking details
    try {
      const needsFill = finalCollaborators.filter(c => c.user && (!c.user.name || c.user.name === 'Unknown' || c.user.image === null));
      const idsToFill = [...new Set(needsFill.map(c => c.user._id).filter(Boolean))];
      if (idsToFill.length) {
        const users = await User.find({ _id: { $in: idsToFill } }).select('name image').lean();
        const userMap = new Map(users.map(u => [String(u._id), u]));
        finalCollaborators = finalCollaborators.map(col => {
          const uid = String(col.user._id);
          const u = userMap.get(uid);
          if (u) {
            return {
              ...col,
              user: {
                _id: uid,
                name: u.name || col.user.name || 'Unknown',
                image: u.image || col.user.image || null,
              }
            };
          }
          return col;
        });
      }
    } catch (e) {
      logger.warn('Failed to backfill collaborator user info:', e?.message || e);
    }

    // Build unified participants array: owner first, then collaborators sorted by joinedAt
    const ownerInfo = meetingObj.userId || {};
    const ownerParticipant = {
      user: {
        _id: ownerInfo._id ? String(ownerInfo._id) : rawUserId,
        name: ownerInfo.name || 'Original Owner',
        email: ownerInfo.email || null,
        image: ownerInfo.image || null,
      },
      role: COLLABORATOR_ROLES.OWNER,
      joinedAt: meetingObj.createdAt || null,
      isOwner: true,
    };

    // Map collaborators (excluding any duplicate owner entries)
    const collaboratorParticipants = finalCollaborators
      .filter(c => c.user && String(c.user._id) !== String(ownerParticipant.user._id))
      .map(c => ({
        user: c.user,
        role: c.role,
        joinedAt: c.joinedAt,
        isOwner: false,
      }))
      .sort((a, b) => new Date(a.joinedAt || 0).getTime() - new Date(b.joinedAt || 0).getTime());

    // Combine: owner first, then collaborators sorted by joinedAt
    const participants = [ownerParticipant, ...collaboratorParticipants];

    // Keep collaborators for backward compatibility but also add participants
    meetingObj.collaborators = finalCollaborators;
    meetingObj.participants = participants;

    // 4. Overwrite/Harmonize Meta-data
    // Move suggested values into main fields if missing (already Done in worker/controller but just in case)
    // AND REMOVE suggestedTitle/suggestedDescription to avoid duplication in JSON response
    delete meetingObj.suggestedTitle;
    delete meetingObj.suggestedDescription;
    // Remove the candidate list from the meeting object itself in response to avoid confusion
    const aiCandidates = meetingObj.actionItems || [];
    delete meetingObj.actionItems;

    // Harmonize: Prioritize Real Tasks > AI Candidates
    // NOTE: hasSyncedTasks should indicate that tasks are migrated (tasks.length > 0).
    const hasSyncedTasks = tasks.length > 0;
    let unifiedActionItems = hasSyncedTasks ? tasks : aiCandidates;

    // If board exists but tasks are not yet migrated, attach boardId (string) to AI candidates
    if (hasBoard && (!tasks || tasks.length === 0) && Array.isArray(unifiedActionItems) && unifiedActionItems.length) {
      const boardIdStr = board && board._id ? String(board._id) : null;
      unifiedActionItems = unifiedActionItems.map(item => ({ ...item, boardId: boardIdStr }));
    }

    // Get permission for response (to include in meeting object)
    const permission = getResourcePermission(meetingObj, currentUserId);

    res.json({
      success: true,
      meeting: {
        ...meetingObj,
        boardId: board?._id ? String(board._id) : undefined,
        hasBoard,
        userRole,
        fileUrl,
        // Only include shareToken if user has share permission
        shareToken: permission.canShare ? meeting.shareToken : undefined,
        // Include permission flags for frontend
        canEdit: permission.canEdit,
        canDelete: permission.canDelete,
        canShare: permission.canShare,
        canManageCollaborators: permission.canManageCollaborators,
      },
      analytics,
      actionItems: unifiedActionItems,
      hasSyncedTasks,
    });
  } catch (error) {
    logger.error('Error getting meeting:', error);
    next(error);
  }
}

/**
 * Get meeting analytics (Legacy endpoint - kept for compatibility)
 */
async function getMeetingAnalytics(req, res, next) {
  try {
    const { id } = req.params;
    const meeting = await Meeting.findById(id);
    if (!meeting) return res.status(404).json({ success: false, message: 'Meeting not found' });
    
    const analytics = calculateAnalytics(meeting);
    res.json({ success: true, data: analytics });
  } catch (error) {
    next(error);
  }
}

/**
 * Get meeting status (for polling)
 */
async function getMeetingStatus(req, res, next) {
  try {
    const { id } = req.params;

    const meeting = await Meeting.findById(id).select('status errorMessage retryCount processingLogs processingMeta');

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

    // Get latest stage and progress from logs
    const latestLog = meeting.processingLogs && meeting.processingLogs.length > 0 
      ? meeting.processingLogs[meeting.processingLogs.length - 1] 
      : null;

    res.json({
      success: true,
      data: {
        meetingId: id,
        status: meeting.status,
        errorMessage: meeting.errorMessage,
        retryCount: meeting.retryCount,
        processingLogs: meeting.processingLogs || [],
        processingStage: latestLog?.stage || null,
        processingProgress: latestLog?.progress || jobStatus?.progress || 0,
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

    // Access check: Only owner, admin, or editor can update
    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(meeting, currentUserId);

    if (!permission.canEdit) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'You do not have permission to update this meeting',
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

    if (updates.tags !== undefined) {
      updateData.tags = updates.tags;
    }
    
    // Note: actionItems are now managed via Task collection
    // Use /api/tasks endpoint to create/update tasks

    const updatedMeeting = await Meeting.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    // Emit socket event for realtime updates
    const userName = req.user?.name || 'Unknown';
    const updateTypes = [];
    if (updates.title !== undefined) updateTypes.push('title_updated');
    if (updates.description !== undefined) updateTypes.push('description_updated');
    if (updates.executiveSummary !== undefined) updateTypes.push('summary_updated');
    if (updates.highlights !== undefined) updateTypes.push('highlights_updated');
    if (updates.conclusion !== undefined) updateTypes.push('conclusion_updated');
    if (updates.tags !== undefined) updateTypes.push('tags_updated');
    
    // Only emit ONE event: meeting_updated with all the update info
    emitToMeeting(id, 'meeting_updated', { 
      meeting: updatedMeeting, 
      updatedBy: { _id: currentUserId, name: userName },
      field: updateTypes[0]?.replace('_updated', '') || 'content',
      updateTypes // Include all update types for debugging
    });

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

    // Access check: Only owner or admin can delete
    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(meeting, currentUserId);
    
    if (!permission.canDelete) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Only the meeting owner or admin can delete it',
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

    // CASCADE DELETE: Delete associated boards and their tasks
    const meetingObjectId = new mongoose.Types.ObjectId(id);

    const boards = await Board.find({ meetingId: meetingObjectId });
    logger.info(`Cleaning up ${boards.length} boards for meeting ${id}`);
    
    for (const board of boards) {
      // Delete all tasks in each board
      const taskDelResult = await Task.deleteMany({ boardId: board._id });
      logger.info(`Deleted ${taskDelResult.deletedCount} tasks for board ${board._id}`);
    }
    
    // Delete all boards linked to this meeting
    const boardDelResult = await Board.deleteMany({ meetingId: meetingObjectId });
    logger.info(`Deleted ${boardDelResult.deletedCount} boards`);
    
    // Also delete any orphan tasks tied to meeting but no board
    const orphanTaskDelResult = await Task.deleteMany({ meetingId: meetingObjectId });
    logger.info(`Deleted ${orphanTaskDelResult.deletedCount} orphan tasks for meeting ${id}`);

    // Emit socket event for real-time update
    try {
      const { emitToMeeting } = require('../services/socketService');
      emitToMeeting(String(meeting._id), 'meeting_deleted', { 
        meetingId: String(meeting._id),
        deletedBy: currentUserId 
      });
    } catch (e) {
      logger.warn('Failed to emit meeting_deleted event', e);
    }

    // Delete meeting from database
    await Meeting.findByIdAndDelete(id);

    res.json({
      success: true,
      message: 'Meeting and related boards/tasks deleted successfully',
      deletedBoardsCount: boardDelResult.deletedCount || 0,
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

    // Access check: owner | collaborator | public
    const currentUserId = req.user?.id || req.user?._id;
    const hasOwnerRole = meeting.collaborators && Array.isArray(meeting.collaborators) && meeting.collaborators.some(c => c && c.role === COLLABORATOR_ROLES.OWNER && currentUserId && idEquals(c.user, currentUserId));
    const isOwner = !!(currentUserId && (idEquals(meeting.userId, currentUserId) || hasOwnerRole));
    const isCollaborator = meeting.collaborators && meeting.collaborators.some(c => c && currentUserId && idEquals(c.user, currentUserId));
    
    const isPublic = meeting.isPublic === true;

    if (!isOwner && !isCollaborator && !isPublic) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'You do not have permission to export this meeting',
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

    // Helper function to format time for SRT (HH:MM:SS,mmm)
    const formatTimeSRT = (seconds) => {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
    };

    // Helper function to format time for VTT (HH:MM:SS.mmm)
    const formatTimeVTT = (seconds) => {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    };

    // Handle SRT format
    if (format === 'srt') {
      let srt = '';
      if (meeting.transcription.segments && meeting.transcription.segments.length > 0) {
        meeting.transcription.segments.forEach((segment, index) => {
          srt += `${index + 1}\n`;
          srt += `${formatTimeSRT(segment.start)} --> ${formatTimeSRT(segment.end)}\n`;
          srt += `${segment.speaker}: ${segment.text}\n\n`;
        });
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${meeting.title || 'transcript'}.srt"`);
      return res.send(srt);
    }

    // Handle VTT format
    if (format === 'vtt') {
      let vtt = 'WEBVTT\n\n';
      if (meeting.transcription.segments && meeting.transcription.segments.length > 0) {
        meeting.transcription.segments.forEach((segment, index) => {
          vtt += `${index + 1}\n`;
          vtt += `${formatTimeVTT(segment.start)} --> ${formatTimeVTT(segment.end)}\n`;
          vtt += `<v ${segment.speaker}>${segment.text}\n\n`;
        });
      }
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${meeting.title || 'transcript'}.vtt"`);
      return res.send(vtt);
    }

    // Handle JSON format
    if (format === 'json') {
      const jsonData = {
        meeting: {
          _id: meeting._id,
          title: meeting.title,
          description: meeting.description,
          createdAt: meeting.createdAt,
          duration: meeting.duration,
          platform: meeting.platform,
          type: meeting.type,
        },
        transcription: meeting.transcription,
        actionItems: meeting.actionItems,
      };
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${meeting.title || 'meeting'}.json"`);
      return res.send(JSON.stringify(jsonData, null, 2));
    }

    // Format transcript (default TXT format)
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
 * Regenerate AI metadata (summary, action items, etc) from existing transcript
 */
async function regenerateMetadata(req, res, next) {
  let meeting;
  try {
    const { id } = req.params;
    meeting = await Meeting.findById(id);

    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    // Access check: owner or editor
    const currentUserId = req.user?.id || req.user?._id;
    const hasOwnerRole = meeting.collaborators && Array.isArray(meeting.collaborators) && meeting.collaborators.some(c => c && c.role === COLLABORATOR_ROLES.OWNER && currentUserId && idEquals(c.user, currentUserId));
    const isOwner = !!(currentUserId && (idEquals(meeting.userId, currentUserId) || hasOwnerRole));
    const isEditor = meeting.collaborators && meeting.collaborators.some(c => c && c.role === 'editor' && currentUserId && idEquals(c.user, currentUserId));

    if (!isOwner && !isEditor) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to regenerate metadata for this meeting',
      });
    }

    if (!meeting.transcription || !meeting.transcription.transcript) {
      return res.status(400).json({ success: false, message: 'No transcript available to regenerate from' });
    }

    await addProcessingLog(meeting, 'Mengulangi analisis AI pada transkrip...');
    
    // Sync logic: Delete existing Kanban board if it exists for this meeting
    // We do this BEFORE regeneration so the user can start fresh
    const meetingObjectId = new mongoose.Types.ObjectId(id);

    const boardCount = await Board.countDocuments({ meetingId: meetingObjectId });
    if (boardCount > 0) {
      // Delete all tasks associated with this meeting
      await Task.deleteMany({ meetingId: meetingObjectId });
      // Delete all boards associated with this meeting
      await Board.deleteMany({ meetingId: meetingObjectId });
      
      await addProcessingLog(meeting, `Semua ${boardCount} board Kanban dan tugas lama dihapus untuk sinkronisasi ulang.`);
    } else {
      // Still clear tasks just in case there are orphan ones
      await Task.deleteMany({ meetingId: meetingObjectId });
    }

    const { analyzeTranscript } = require('../services/whisperxService');
    const result = await analyzeTranscript(meeting.transcription.transcript);
    // Persist a one-time raw snapshot of the analyze result for debugging/audit
    try {
      await addProcessingLog(meeting, `Raw analyze result snapshot: ${JSON.stringify(result).slice(0,2000)}`);
    } catch (e) {
      logger.debug('Failed to persist raw analyze snapshot', e.message);
    }
    // Log diagnostics from LLM and the action_items payload to aid debugging
    try {
      if (result.__llm_diagnostics) logger.debug('LLM diagnostics:', result.__llm_diagnostics);
      const aiPayload = result.actionItems || result.action_items || [];
      logger.debug('Regenerate analyze result action_items sample:', JSON.stringify((Array.isArray(aiPayload) ? aiPayload.slice(0,5) : aiPayload)));
    } catch (e) {
      // ignore logging errors
    }

    // Update transcription fields
    meeting.transcription.summary = result.summary || meeting.transcription.summary;
    meeting.transcription.highlights = result.highlights || meeting.transcription.highlights;
    meeting.transcription.conclusion = result.conclusion || meeting.transcription.conclusion;
    
    if (result.suggestedDescription) {
      meeting.description = result.suggestedDescription;
    }
    
    // Update tags if available
    if (result.tags && Array.isArray(result.tags)) {
      meeting.tags = result.tags;
    }
    
    if (result.suggestedTitle) {
      meeting.suggestedTitle = result.suggestedTitle;
      // Always apply to main title if it looks like a placeholder
      const isPlaceholder = !meeting.title || 
        meeting.title.includes('Meeting') || 
        meeting.title.includes('Upload') || 
        meeting.title.includes('video_') || 
        meeting.title.includes('audio_') ||
        (meeting.originalFile?.originalName && meeting.originalFile.originalName.toLowerCase().startsWith(meeting.title.toLowerCase()));
      
      if (isPlaceholder) {
        meeting.title = result.suggestedTitle;
      }
    }

    if (result.suggestedDescription) {
      meeting.description = result.suggestedDescription;
    } else if (!meeting.description && result.summary && !result.summary.includes('tidak tersedia')) {
      // Fallback: use first sentence of summary
      const firstSentence = result.summary.split('.')[0].replace(/[*#]/g, '').trim();
      meeting.description = firstSentence + '.';
    }

    // Merge/Update action items (candidates)
    const rawActionItems = Array.isArray(result.actionItems)
      ? result.actionItems
      : (Array.isArray(result.action_items) ? result.action_items : []);


    if (rawActionItems.length > 0) {
      const newCandidates = [];
      for (const item of rawActionItems) {
        const dueRaw = item.dueDate ?? item.due_date ?? item.dueDateRaw ?? item.due ?? null;
        let norm = normalizeDate(dueRaw);

        let needsDate = false;
        // If backend couldn't parse due date, try extracting from transcript near the task text
        if ((!norm || !norm.date) && meeting.transcription && meeting.transcription.transcript) {
          try {
            const query = (item.title || item.text || item.description || '').slice(0, 200);
            const ext = extractDateFromText(meeting.transcription.transcript, query);
            if (ext && ext.date) {
              norm = ext;
            }
          } catch (e) {
            // ignore extraction errors
          }
        }

        if (!norm || !norm.date) needsDate = true;

        newCandidates.push({
          title: item.title || item.text || 'Untitled Task',
          description: item.description || '',
          priority: item.priority || 'medium',
          dueDate: norm && norm.date ? norm.date : null,
          dueDateRaw: norm && norm.raw ? norm.raw : (dueRaw || null),
          assigneeName: item.assigneeName || item.assignee_name || null,
          labels: item.labels || item.labels || [],
          status: 'todo',
          needsDate,
        });
      }

      // Only overwrite candidates if new items were actually returned
      meeting.actionItems = newCandidates;
    }

    await addProcessingLog(meeting, 'Analisis AI berhasil diperbarui.');
    await meeting.save();

    // Emit socket event for realtime updates
    const userName = req.user?.name || 'Unknown';
    emitMeetingAiRegenerated(id, userName);

    // Harmonize response (same as in getMeetingById)
    const meetingObj = meeting.toObject();
    delete meetingObj.suggestedTitle;
    delete meetingObj.suggestedDescription;
    const aiCandidates = meetingObj.actionItems || [];
    delete meetingObj.actionItems;
    delete meetingObj.summarySnippet;

    res.json({
      success: true,
      message: 'AI metadata regenerated successfully',
      meeting: meetingObj,
      actionItems: aiCandidates, // On regeneration, we return the new candidates
      hasSyncedTasks: false,     // Regeneration usually means tasks aren't synced yet or we want to show new ones
    });
  } catch (error) {
    logger.error('Error regenerating metadata:', error);
    if (meeting) await addProcessingLog(meeting, `Gagal regenerasi: ${error.message}`);
    next(error);
  }
}

/**
 * Update speaker name in all or single segment
 */
async function updateSpeakerName(req, res, next) {
  try {
    const { id } = req.params;
    const { oldSpeakerName, newSpeakerName, segmentIndex, applyToAll } = req.body;

    if (!newSpeakerName) {
      return res.status(400).json({ success: false, message: 'New speaker name is required' });
    }

    const meeting = await Meeting.findById(id);
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    // Access check: owner or editor
    const currentUserId = req.user?.id || req.user?._id;
    const hasOwnerRole = meeting.collaborators && Array.isArray(meeting.collaborators) && meeting.collaborators.some(c => c && c.role === COLLABORATOR_ROLES.OWNER && currentUserId && idEquals(c.user, currentUserId));
    const isOwner = !!(currentUserId && (idEquals(meeting.userId, currentUserId) || hasOwnerRole));
    const isEditor = meeting.collaborators && meeting.collaborators.some(c => c && c.role === 'editor' && currentUserId && idEquals(c.user, currentUserId));

    if (!isOwner && !isEditor) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update speaker names for this meeting',
      });
    }

    if (!meeting.transcription || !meeting.transcription.segments) {
      return res.status(400).json({ success: false, message: 'No transcription segments found' });
    }

    let updatedCount = 0;
    if (applyToAll) {
      meeting.transcription.segments.forEach(seg => {
        if (seg.speaker === oldSpeakerName) {
          seg.speaker = newSpeakerName;
          updatedCount++;
        }
      });

      // Also update speakers metadata if exists
      if (meeting.transcription.speakers) {
        meeting.transcription.speakers.forEach(s => {
          if (s.speaker === oldSpeakerName) {
            s.speaker = newSpeakerName;
          }
        });
      }
    } else if (segmentIndex !== undefined) {
      if (meeting.transcription.segments[segmentIndex]) {
        meeting.transcription.segments[segmentIndex].speaker = newSpeakerName;
        updatedCount = 1;
      }
    }

    if (updatedCount > 0) {
      // Mark as modified for Mongoose Mixed types if necessary, though segments is a schema
      meeting.markModified('transcription.segments');
      meeting.markModified('transcription.speakers');
      await meeting.save();

      // Emit socket event for realtime updates
      const userName = req.user?.name || 'Unknown';
      emitMeetingContentUpdated(id, 'segment_edited', { 
        oldSpeakerName, 
        newSpeakerName, 
        segmentIndex, 
        applyToAll,
        updatedCount 
      }, userName);
    }

    res.json({
      success: true,
      message: `Updated ${updatedCount} segments`,
      updatedCount
    });
  } catch (error) {
    logger.error('Error updating speaker name:', error);
    next(error);
  }
}

/**
 * Ask AI a question about the meeting context
 * POST /api/meetings/:id/ask
 */
async function askAI(req, res, next) {
  try {
    const { id } = req.params;
    const { question } = req.body;
    const userId = req.user?.id || req.user?._id;

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Question is required',
      });
    }

    // Find meeting and check permissions
    const meeting = await Meeting.findById(id);
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    const permission = getResourcePermission(meeting, userId);
    if (!permission.canView) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Build context from meeting data
    const meetingContext = buildMeetingContext(meeting);
    
    // Get recent chat history for context (last 10 messages)
    let chatHistory = [];
    try {
      chatHistory = await ChatMessage.find({ meetingId: id })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();
      chatHistory.reverse(); // Oldest first
    } catch (chatErr) {
      logger.warn('Could not fetch chat history:', chatErr.message);
    }

    // Save user's question to chat history (non-blocking)
    let userMessage = null;
    try {
      userMessage = await ChatMessage.addMessage(id, userId, 'user', question.trim());
    } catch (saveErr) {
      logger.warn('Could not save user message:', saveErr.message);
    }

    // Call LLM service
    const startTime = Date.now();
    let aiResponse;
    try {
      aiResponse = await callLLMForQuestion(meetingContext, chatHistory, question.trim());
    } catch (llmError) {
      logger.error('LLM service error:', llmError.message);
      
      // Try saving error message (non-blocking)
      try {
        await ChatMessage.addMessage(id, null, 'assistant', 
          'Maaf, terjadi kesalahan saat memproses pertanyaan Anda. Silakan coba lagi.',
          { error: llmError.message }
        );
      } catch (e) { /* ignore */ }
      
      return res.status(500).json({
        success: false,
        message: 'Failed to process question',
        error: llmError.message,
      });
    }
    const responseTime = Date.now() - startTime;

    // Save AI response to chat history (non-blocking)
    let assistantMessage = { content: aiResponse, _id: null };
    try {
      assistantMessage = await ChatMessage.addMessage(id, null, 'assistant', aiResponse, {
        responseTime,
        model: process.env.LLM_MODEL || 'google/gemma-3-4b-it:free',
      });
    } catch (saveErr) {
      logger.warn('Could not save assistant message:', saveErr.message);
    }

    res.json({
      success: true,
      data: {
        question: question.trim(),
        answer: aiResponse,
        messageId: assistantMessage?._id || null,
        responseTime,
      },
    });
  } catch (error) {
    logger.error('Ask AI error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
}

/**
 * Get chat history for a meeting
 * GET /api/meetings/:id/chat
 */
async function getChatHistory(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user?.id || req.user?._id;
    const limit = parseInt(req.query.limit) || 50;

    const meeting = await Meeting.findById(id);
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    const permission = getResourcePermission(meeting, userId);
    if (!permission.canView) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const messages = await ChatMessage.getChatHistory(id, limit);

    res.json({
      success: true,
      data: messages,
    });
  } catch (error) {
    logger.error('Get chat history error:', error);
    next(error);
  }
}

/**
 * Clear chat history for a meeting
 * DELETE /api/meetings/:id/chat
 */
async function clearChatHistory(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user?.id || req.user?._id;

    const meeting = await Meeting.findById(id);
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    const permission = getResourcePermission(meeting, userId);
    if (!permission.canManageCollaborators) {
      return res.status(403).json({ success: false, message: 'Only owner or admin can clear chat history' });
    }

    await ChatMessage.clearHistory(id);

    res.json({
      success: true,
      message: 'Chat history cleared',
    });
  } catch (error) {
    logger.error('Clear chat history error:', error);
    next(error);
  }
}

/**
 * Build meeting context for LLM
 */
function buildMeetingContext(meeting) {
  let context = `# Meeting: ${meeting.title || 'Untitled Meeting'}\n\n`;
  
  if (meeting.description) {
    context += `## Deskripsi\n${meeting.description}\n\n`;
  }

  // Meeting metadata
  if (meeting.createdAt) {
    context += `**Tanggal:** ${new Date(meeting.createdAt).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`;
  }
  if (meeting.duration) {
    const mins = Math.floor(meeting.duration / 60);
    context += `**Durasi:** ${mins} menit\n`;
  }
  if (meeting.tags && meeting.tags.length > 0) {
    context += `**Topik:** ${meeting.tags.join(', ')}\n`;
  }
  context += '\n';

  // Use transcription object (correct structure)
  const transcription = meeting.transcription || {};

  if (transcription.summary) {
    context += `## Ringkasan\n${transcription.summary}\n\n`;
  }

  if (transcription.highlights && typeof transcription.highlights === 'object') {
    context += `## Poin-Poin Penting\n`;
    for (const [topic, content] of Object.entries(transcription.highlights)) {
      context += `### ${topic}\n${content}\n\n`;
    }
  }

  if (transcription.conclusion) {
    context += `## Kesimpulan\n${transcription.conclusion}\n\n`;
  }

  // Include action items from meeting.actionItems (AI candidates)
  const actionItems = meeting.actionItems || [];
  if (actionItems.length > 0) {
    context += `## Action Items / Tugas\n`;
    actionItems.forEach((item, i) => {
      context += `${i + 1}. **${item.title}**`;
      if (item.description) context += `: ${item.description}`;
      if (item.priority) context += ` (Prioritas: ${item.priority})`;
      if (item.dueDate) context += ` - Deadline: ${item.dueDate}`;
      context += '\n';
    });
    context += '\n';
  }

  // Include full transcript with speakers for better Q&A context
  if (transcription.segments && transcription.segments.length > 0) {
    context += `## Transkrip Lengkap\n`;
    // Include all segments for comprehensive context (up to 200 to avoid excessive tokens)
    const segments = transcription.segments.slice(0, 200);
    segments.forEach(seg => {
      const speaker = seg.speaker || 'Speaker';
      const timestamp = seg.start ? `[${formatSeconds(seg.start)}]` : '';
      context += `${timestamp} **${speaker}**: ${seg.text}\n`;
    });
    
    if (transcription.segments.length > 200) {
      context += `\n... (${transcription.segments.length - 200} segmen lainnya tidak ditampilkan)\n`;
    }
  }

  return context;
}

/**
 * Format seconds to MM:SS or HH:MM:SS
 */
function formatSeconds(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Call LLM service for question answering
 */
async function callLLMForQuestion(meetingContext, chatHistory, question) {
  const WHISPER_URL = config.WHISPERX_API_URL || 'http://localhost:5005';
  
  // Build messages array for chat completion
  const messages = [
    {
      role: 'system',
      content: `Kamu adalah asisten AI cerdas yang membantu menjawab pertanyaan tentang notulensi rapat.

KEMAMPUANMU:
- Menjawab pertanyaan tentang isi rapat (siapa bilang apa, keputusan apa yang diambil, dll)
- Meringkas bagian tertentu dari rapat
- Mencari informasi spesifik dari transkrip
- Menjelaskan konteks dan hubungan antar topik yang dibahas
- Mengidentifikasi tugas dan action items
- Menganalisis sentimen dan dinamika diskusi

PANDUAN MENJAWAB:
1. Jawab dengan jelas, ringkas, dan terstruktur
2. Jika ada kutipan relevan dari transkrip, sertakan dengan menyebut pembicara
3. Jika informasi tidak ada dalam konteks rapat, katakan dengan jujur
4. Gunakan format markdown untuk memperjelas (bold, bullet points, dll)
5. Jawab dalam bahasa Indonesia

Konteks rapat di bawah ini berisi ringkasan, poin-poin penting, kesimpulan, action items, dan transkrip lengkap.`
    },
    {
      role: 'user',
      content: `Berikut adalah konteks lengkap rapat:\n\n${meetingContext}`
    }
  ];

  // Add chat history
  chatHistory.forEach(msg => {
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: msg.content });
    }
  });

  // Add current question (if not already in history)
  const lastMsg = messages[messages.length - 1];
  if (lastMsg.role !== 'user' || lastMsg.content !== question) {
    messages.push({ role: 'user', content: question });
  }

  try {
    const response = await axios.post(`${WHISPER_URL}/api/chat`, {
      messages,
      max_tokens: 1000,
    }, {
      timeout: 60000,
      validateStatus: () => true, // Don't throw on non-2xx status
    });

    // Check if faster-whisper returned success
    if (response.data?.success && response.data?.response) {
      return response.data.response;
    }
    
    // If faster-whisper returned error, log and try fallback
    const errorMsg = response.data?.error || response.data?.response || `HTTP ${response.status}: ${response.statusText}`;
    logger.warn(`Faster-whisper chat error (${WHISPER_URL}): ${errorMsg}, trying fallback...`);
    
    // Fallback: Try direct OpenRouter
    if (process.env.OPENROUTER_API_KEY) {
      logger.info('Trying OpenRouter direct fallback...');
      return await callOpenRouterDirect(messages);
    }
    
    throw new Error(`Faster-whisper error: ${errorMsg}. OpenRouter API key not configured.`);
  } catch (error) {
    logger.error('Error calling LLM service:', {
      message: error.message,
      code: error.code,
      url: `${WHISPER_URL}/api/chat`,
      hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY
    });
    
    // Fallback: Try direct OpenRouter if faster-whisper endpoint fails
    if (process.env.OPENROUTER_API_KEY) {
      logger.info('Trying OpenRouter fallback after connection error...');
      try {
        return await callOpenRouterDirect(messages);
      } catch (fallbackError) {
        logger.error('OpenRouter fallback also failed:', fallbackError.message);
        throw new Error(`LLM service unavailable. Faster-whisper: ${error.message}. OpenRouter: ${fallbackError.message}`);
      }
    }
    
    // No fallback available
    if (error.code === 'ECONNREFUSED') {
      throw new Error(`Faster-whisper service is not running at ${WHISPER_URL}. Please start the service or configure OPENROUTER_API_KEY.`);
    }
    
    throw new Error(`LLM service error: ${error.message}. Please configure OPENROUTER_API_KEY as fallback.`);
  }
}

/**
 * Direct OpenRouter call as fallback
 */
async function callOpenRouterDirect(messages) {
  try {
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: process.env.LLM_MODEL || 'google/gemma-3-4b-it:free',
      messages,
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
      validateStatus: () => true,
    });

    if (response.status !== 200) {
      const errorMsg = response.data?.error?.message || response.data?.error || `HTTP ${response.status}`;
      throw new Error(`OpenRouter API error: ${errorMsg}`);
    }

    if (response.data?.choices?.[0]?.message?.content) {
      return response.data.choices[0].message.content;
    }
    
    throw new Error('OpenRouter returned empty response');
  } catch (error) {
    if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
      throw new Error('Cannot connect to OpenRouter API. Check your internet connection.');
    }
    throw error;
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
  regenerateMetadata,
  generateShareLink,
  joinMeeting,
  revokeShareLink,
  updateCollaboratorRole,
  removeCollaborator,
  updateSpeakerName,
  askAI,
  getChatHistory,
  clearChatHistory,
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

/**
 * Sharing & Collaboration
 */
async function generateShareLink(req, res, next) {
  try {
    const { id } = req.params;
    const meeting = await Meeting.findById(id);

    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    // Check permission - only owner or admin can generate share link
    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(meeting, currentUserId);
    
    if (!permission.canShare) {
      return res.status(403).json({ success: false, message: 'Only owners and admins can generate share links' });
    }

    if (!meeting.shareToken) {
      // Attempt to generate and save a unique shareToken, retrying on duplicate-key
      const maxRetries = 5;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        meeting.shareToken = nanoid(10);
        try {
          await meeting.save();
          break;
        } catch (err) {
          // Mongo duplicate key error
          if (err && (err.code === 11000 || err.code === 11001)) {
            logger.warn(`Share token collision on attempt ${attempt + 1}, retrying`);
            // try again with a new token
            if (attempt === maxRetries - 1) throw err;
            continue;
          }
          throw err;
        }
      }
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.json({
      success: true,
      data: {
        shareToken: meeting.shareToken,
        shareUrl: `${frontendUrl}/dashboard/join/meeting/${meeting.shareToken}`
      }
    });
  } catch (error) {
    logger.error('Error generating share link:', error);
    next(error);
  }
}

async function joinMeeting(req, res, next) {
  try {
    const { token } = req.params;
    const meeting = await Meeting.findOne({ shareToken: token });

    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Invalid share link' });
    }
    
    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(meeting, currentUserId);

    // If user already has access, return their current role
    if (permission.canView) {
      // Re-fetch with populate for response
      const populatedMeeting = await Meeting.findById(meeting._id)
        .populate('userId', 'name email image')
        .populate('collaborators.user', 'name email image');
      
      return res.json({
        success: true,
        message: permission.isOwner ? 'You are the owner of this meeting' : 'You are already a member of this meeting',
        data: { 
          meeting: {
            _id: populatedMeeting._id,
            id: populatedMeeting._id,
            title: populatedMeeting.title,
          },
          meetingId: populatedMeeting._id,
          role: permission.role,
          alreadyMember: true,
        }
      });
    }

    // Add as viewer collaborator
    try {
      const updateResult = await Meeting.updateOne(
        { _id: meeting._id, 'collaborators.user': { $ne: currentUserId } },
        { $push: { collaborators: { user: currentUserId, role: COLLABORATOR_ROLES.VIEWER, joinedAt: new Date() } } }
      );

      // Emit socket event for real-time update
      if (updateResult && updateResult.modifiedCount > 0) {
        try {
          const { emitCollaboratorJoined } = require('../services/socketService');
          emitCollaboratorJoined('meeting', String(meeting._id), {
            id: currentUserId,
            name: req.user?.name || 'Anonymous',
            image: req.user?.image || null,
          }, COLLABORATOR_ROLES.VIEWER);
        } catch (e) {
          logger.warn('Failed to emit collaborator_joined after join', e);
        }
      }
    } catch (e) {
      logger.warn('Failed to atomically add collaborator on join:', e?.message || e);
    }

    // Re-fetch populated meeting for consistent response shape
    const populatedMeeting = await Meeting.findById(meeting._id)
      .populate('userId', 'name email image')
      .populate('collaborators.user', 'name email image');

    res.json({
      success: true,
      message: 'Joined meeting successfully',
      data: { 
        meeting: {
          _id: populatedMeeting._id,
          id: populatedMeeting._id,
          title: populatedMeeting.title,
        },
        meetingId: populatedMeeting._id,
        role: COLLABORATOR_ROLES.VIEWER,
        alreadyMember: false,
      }
    });
  } catch (error) {
    logger.error('Error joining meeting:', error);
    next(error);
  }
}

async function revokeShareLink(req, res, next) {
  try {
    const { id } = req.params;
    const meeting = await Meeting.findById(id);

    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    // Check permission - only owner or admin can revoke share link
    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(meeting, currentUserId);
    
    if (!permission.canShare) {
      return res.status(403).json({ success: false, message: 'Only owners and admins can revoke share links' });
    }

    meeting.shareToken = undefined;
    await meeting.save();

    res.json({ success: true, message: 'Share link revoked' });
  } catch (error) {
    logger.error('Error revoking share link:', error);
    next(error);
  }
}

async function updateCollaboratorRole(req, res, next) {
  try {
    const { id, odellollaboratorId } = req.params;
    const { role } = req.body;
    const collaboratorId = odellollaboratorId || req.params.userId; // Support both param names

    // Validate role
    const { isValidRole, canAssignRole } = require('../utils/permissions');
    if (!role || !isValidRole(role) || role === COLLABORATOR_ROLES.OWNER) {
      return res.status(400).json({ success: false, message: 'Invalid role. Allowed: admin, editor, viewer' });
    }

    const meeting = await Meeting.findById(id);
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    // Check permission - only owner or admin can manage collaborators
    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(meeting, currentUserId);
    
    if (!permission.canManageCollaborators) {
      return res.status(403).json({ success: false, message: 'Only owners and admins can update roles' });
    }

    // Check if current user can assign this role
    if (!canAssignRole(permission.role, role)) {
      return res.status(403).json({ success: false, message: 'You cannot assign this role level' });
    }

    const col = meeting.collaborators.find(c => c.user && idEquals(c.user, collaboratorId));
    if (!col) {
      return res.status(404).json({ success: false, message: 'Collaborator not found' });
    }

    col.role = role;
    await meeting.save();

    // Emit socket event
    try {
      const { emitCollaboratorRoleChanged } = require('../services/socketService');
      emitCollaboratorRoleChanged('meeting', String(meeting._id), collaboratorId, role);
    } catch (e) {
      logger.warn('Failed to emit role change event', e);
    }

    res.json({ success: true, message: 'Role updated', data: { collaboratorId, newRole: role } });
  } catch (error) {
    logger.error('Error updating collaborator role:', error);
    next(error);
  }
}

async function removeCollaborator(req, res, next) {
  try {
    const { id, odellollaboratorId } = req.params;
    const collaboratorId = odellollaboratorId || req.params.userId; // Support both param names
    
    const meeting = await Meeting.findById(id);
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(meeting, currentUserId);
    const isSelfRemoval = idEquals(collaboratorId, currentUserId);

    // Allow self-removal or manager removal
    if (!isSelfRemoval && !permission.canManageCollaborators) {
      return res.status(403).json({ success: false, message: 'Permission denied' });
    }

    const originalLength = meeting.collaborators.length;
    meeting.collaborators = meeting.collaborators.filter(c => !(c.user && idEquals(c.user, collaboratorId)));
    
    if (meeting.collaborators.length === originalLength) {
      return res.status(404).json({ success: false, message: 'Collaborator not found' });
    }

    await meeting.save();

    // Emit socket event
    try {
      const { emitCollaboratorRemoved } = require('../services/socketService');
      emitCollaboratorRemoved('meeting', String(meeting._id), collaboratorId);
    } catch (e) {
      logger.warn('Failed to emit collaborator removed event', e);
    }

    res.json({ success: true, message: 'Collaborator removed' });
  } catch (error) {
    logger.error('Error removing collaborator:', error);
    next(error);
  }
}
