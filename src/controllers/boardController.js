// @ts-nocheck
const mongoose = require('mongoose');
const Board = require('../models/Board');
const Task = require('../models/Task');
const Meeting = require('../models/Meeting');
const { idEquals } = require('../utils/idEquals');
const { getResourcePermission, isValidRole, canAssignRole } = require('../utils/permissions');
const User = require('../models/User');
const crypto = require('crypto');
const nanoid = (size = 10) => crypto.randomBytes(size).toString('hex').slice(0, size);
const { COLLABORATOR_ROLES } = require('../utils/constants');
const logger = require('../utils/logger');

exports.getBoards = async (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 12;
    const skip = (page - 1) * limit;
    const search = req.query.search;
    const currentUserId = req.user?.id || req.user?._id;
    let reqUserId = null;
    try {
      if (currentUserId) {
        reqUserId = new mongoose.Types.ObjectId(currentUserId);
      }
    } catch (e) {
      console.warn('Invalid user ID for board aggregation:', currentUserId);
    }

    let query = {};

    // Use ObjectId for aggregation matching
    const userIdToMatch = reqUserId || req.user.id;

    if (filter === 'mine') {
      query.userId = userIdToMatch;
    } else if (filter === 'shared') {
      query['collaborators.user'] = userIdToMatch;
      query.userId = { $ne: userIdToMatch };
    } else {
      query.$or = [
        { userId: userIdToMatch },
        { 'collaborators.user': userIdToMatch }
      ];
    }

    if (search) {
      const searchOr = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];

      if (query.$or && Array.isArray(query.$or) && query.$or.length) {
        query.$and = [{ $or: query.$or }, { $or: searchOr }];
        delete query.$or;
      } else {
        query.$or = searchOr;
      }
    }
    // Source filter (ai/generated or manual)
    if (req.query.source) {
      // Accept either 'ai' or 'manual' (client may send 'generated' map to 'ai')
      const src = req.query.source === 'generated' ? 'ai' : req.query.source
      query.source = src
    }
    // If client asks for boards tied to a specific meeting, filter by meetingId
    if (req.query.meetingId) {
      query.meetingId = req.query.meetingId
    }

    // Aggregation Pipeline for Pinned Sorting

    // Use standard find to avoid Aggregation ObjectId casting issues
    const boardsAll = await Board.find(query)
      .populate('userId', 'name email image')
      .populate('collaborators.user', 'name email image')
      .populate('meetingId', 'title')
      .lean();

    const currentUserIdStr = currentUserId ? String(currentUserId) : null;

    // Calculate pinned info and Sort in memory (Pinned First, then Newest)
    const boardsSorted = boardsAll.map(board => {
      const isPinned = currentUserIdStr && board.pinnedBy && Array.isArray(board.pinnedBy)
        ? board.pinnedBy.some(p => p.user && String(p.user) === currentUserIdStr)
        : false;
      return { ...board, isPinned };
    }).sort((a, b) => {
      // 1. Pinned first
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      // 2. Newest first
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    // Manual Pagination
    const total = boardsSorted.length;
    const startIndex = (page - 1) * limit;
    const paginatedBoards = boardsSorted.slice(startIndex, startIndex + limit);

    // Map permissions
    const boardsWithRole = paginatedBoards.map(board => {
      const permission = getResourcePermission(board, currentUserId);
      const canShare = permission.isOwner || permission.role === 'admin';
      return {
        ...board,
        userRole: permission.role || 'viewer',
        isOwner: permission.isOwner,
        canEdit: permission.canEdit,
        canDelete: permission.canDelete,
        canManageCollaborators: permission.canManageCollaborators,
        pinned: board.isPinned,
        ...(canShare && board.shareToken ? { shareToken: board.shareToken } : {}),
      };
    });

    res.json({
      success: true,
      count: boardsWithRole.length,
      data: boardsWithRole,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      }
    });
  } catch (error) {
    logger.error('getBoards error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getBoard = async (req, res) => {
  try {
    const board = await Board.findById(req.params.id)
      .populate('userId', 'name email image')
      .populate('collaborators.user', 'name email image');

    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found' });
    }

    // If board has no owner (legacy/orphaned data), do not persistently assign one.
    // We'll keep permission checks unchanged and provide a non-destructive display fallback
    // later when shaping the response so we do not modify DB state here.

    // Access check (handle populated and non-populated references)
    const currentUserId = String(req.user?.id || req.user?._id || '');

    // Helper to extract a comparable id string from various user representations
    const extractId = (val) => {
      try {
        if (!val && val !== 0) return null;
        if (typeof val === 'object' && val._id) return String(val._id);
        return String(val);
      } catch (e) {
        return String(val);
      }
    };

    const ownerIdStr = extractId(board.userId);
    const hasOwnerRole = Array.isArray(board.collaborators) && board.collaborators.some(c => c && c.role === COLLABORATOR_ROLES.OWNER && extractId(c.user) === currentUserId);
    const isOwner = !!(currentUserId && (ownerIdStr === currentUserId || hasOwnerRole));

    const isCollaborator = Array.isArray(board.collaborators) && board.collaborators.some(c => c && extractId(c.user) === currentUserId);

    if (!isOwner && !isCollaborator) {
      // Debug info to diagnose unexpected 403s
      try {
        const collIds = (Array.isArray(board.collaborators) ? board.collaborators.map(c => extractId(c.user)) : []);
        const userIdStr = currentUserId || null;
        console.warn('Unauthorized access to board:', {
          boardId: board._id?.toString(),
          ownerId: ownerIdStr,
          requesterId: userIdStr,
          collaboratorIds: collIds,
          populatedUserIdType: typeof board.userId,
        });
      } catch (e) {
        console.warn('Unauthorized access to board (failed to log debug info)');
      }
      return res.status(403).json({ success: false, message: 'Unauthorized access to board' });
    }

    // Get role
    let userRole = 'viewer';
    if (isOwner) userRole = 'owner';
    else if (isCollaborator) {
      const col = board.collaborators.find(c => {
        if (!c.user) return false;
        const collUserId = c.user._id ? c.user._id.toString() : c.user.toString();
        return collUserId === req.user.id;
      });
      if (col && col.role) userRole = col.role;
    }

    // Shape response without mutating DB: provide a fallback display owner if needed.
    const boardObj = board.toObject();
    if (!boardObj.userId) {
      boardObj.userId = { _id: null, name: 'Original Owner', image: null, _fallback: true };
    }

    // Backfill collaborator user display fields when populate failed or returned partial objects
    try {
      const collabs = Array.isArray(boardObj.collaborators) ? boardObj.collaborators : [];
      const missingUserIds = collabs
        .map(c => c && (c.user?._id ? String(c.user._id) : (c.user ? String(c.user) : null)))
        .filter(Boolean)
        .filter(id => {
          // keep those where user is not an object or missing name
          const c = collabs.find(x => String(x.user?._id ?? x.user) === id);
          return !c.user || typeof c.user !== 'object' || !c.user.name;
        });

      if (missingUserIds.length) {
        const users = await User.find({ _id: { $in: missingUserIds } }).select('name image');
        const userMap = new Map(users.map(u => [String(u._id), u]));
        boardObj.collaborators = collabs.map(c => {
          if (!c) return c;
          const uid = c.user?._id ? String(c.user._id) : (c.user ? String(c.user) : null);
          if (!uid) return c;
          const u = userMap.get(uid);
          if (u) {
            return { ...c, user: { _id: u._id, name: u.name || 'Unknown', image: u.image || null } };
          }
          // fallback
          return { ...c, user: { _id: uid, name: c.user && c.user.name ? c.user.name : 'Unknown', image: c.user && c.user.image ? c.user.image : null } };
        });
      }
    } catch (e) {
      // Best-effort backfill; don't fail the whole request
      console.warn('Failed to backfill board collaborators', e?.message || e);
    }

    res.json({
      success: true,
      data: {
        ...boardObj,
        userRole
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.createBoard = async (req, res) => {
  try {
    const { title, description } = req.body;
    const board = await Board.create({
      userId: req.user.id,
      title,
      description,
      source: 'manual'
    });
    res.status(201).json({ success: true, data: board });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.deleteBoard = async (req, res) => {
  try {
    const { id } = req.params;
    const board = await Board.findById(id);
    if (!board) return res.status(404).json({ success: false, message: 'Board not found' });

    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(board, currentUserId);

    // Also allow meeting owner to delete the board
    let isMeetingOwner = false;
    if (!permission.canDelete && board.meetingId) {
      try {
        const meeting = await Meeting.findById(board.meetingId);
        if (meeting && idEquals(meeting.userId, currentUserId)) {
          isMeetingOwner = true;
        }
      } catch (e) {
        // ignore lookup errors
      }
    }

    if (!permission.canDelete && !isMeetingOwner) {
      return res.status(403).json({ success: false, message: 'Only owner or admin can delete board' });
    }

    // Delete all tasks in board (CASCADE to tasks)
    const taskDelResult = await Task.deleteMany({ boardId: board._id });
    logger.info(`Deleted ${taskDelResult.deletedCount} tasks for board ${id}`);

    // If board is linked to a meeting, just unlink it (DO NOT delete meeting)
    if (board.meetingId) {
      // Optionally: clear related tasks from meeting (unset meetingId from orphan tasks)
      await Task.updateMany({ meetingId: board.meetingId, boardId: board._id }, { $unset: { boardId: '' } });
      logger.info(`Unlinked board ${id} from meeting ${board.meetingId}`);
    }

    await board.deleteOne();

    // Emit socket event
    try {
      const { emitToBoard } = require('../services/socketService');
      emitToBoard(id, 'board_deleted', { boardId: id, deletedBy: currentUserId });
    } catch (e) {
      logger.warn('Failed to emit board_deleted event', e);
    }

    res.json({ 
      success: true, 
      message: 'Board and tasks deleted successfully',
      deletedTasksCount: taskDelResult.deletedCount || 0,
    });
  } catch (error) {
    logger.error('deleteBoard error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.createFromMeeting = async (req, res) => {
  try {
    // Accept either { meetingId: 'id' } or plain string in body
    let meetingIdRaw = req.body && req.body.meetingId !== undefined ? req.body.meetingId : req.body
    if (!meetingIdRaw) {
      return res.status(400).json({ success: false, message: 'Meeting ID required' });
    }

    const meetingId = (typeof meetingIdRaw === 'object' && meetingIdRaw.meetingId) ? meetingIdRaw.meetingId : meetingIdRaw

    // Only meeting owner may create/migrate a board. Editors/viewers cannot.
    const meeting = await Meeting.findOne({
      _id: meetingId,
      userId: req.user.id
    });
    if (!meeting) {
      return res.status(403).json({ success: false, message: 'Only the meeting owner may create or migrate a board' });
    }

    // Check if board already exists for this meeting
    let board = await Board.findOne({ meetingId: meeting._id });
    
    if (board) {
      // If the board exists but the requesting user isn't the owner or a collaborator,
      // add them as a viewer so they can open the board after migration.
      // Do NOT automatically assign a missing owner to the requester here; preserve DB state.
      const isOwner = idEquals(board.userId, req.user.id);
      const isCollaborator = Array.isArray(board.collaborators) && board.collaborators.some(c => c && c.user && idEquals(c.user, req.user.id));
      if (!isOwner && !isCollaborator) {
        board.collaborators = board.collaborators || [];
        board.collaborators.push({
          user: req.user.id,
          role: COLLABORATOR_ROLES.VIEWER
        });
        await board.save();
      }
    } else {
      // Create Board
      board = await Board.create({
        userId: req.user.id,
        meetingId: meeting._id,
        title: meeting.title || 'Untitled Meeting Kanban',
        description: `Generated from meeting on ${new Date(meeting.createdAt).toLocaleDateString()}`,
        source: 'ai'
      });
    }

    // Update Tasks - migrate all tasks for this meeting to the new board
    try {
      const preCount = await Task.countDocuments({ meetingId: meeting._id });
      console.info(`Migrating tasks for meeting ${meeting._id.toString()}: found ${preCount} tasks`);
      if (preCount > 0) {
        const updated = await Task.updateMany(
          { meetingId: meeting._id },
          { $set: { boardId: board._id, source: 'ai' } }
        );
        console.info(`Tasks migrated: ${updated.modifiedCount}`);
        // expose updated for response
        var tasksMigratedCount = updated.modifiedCount;
      } else {
        console.info('No tasks to migrate for meeting', meeting._id.toString());
        var tasksMigratedCount = 0;
      }
    } catch (err) {
      console.error('Error migrating tasks for meeting', meeting._id.toString(), err);
      var tasksMigratedCount = 0;
    }

    // If no existing Task documents were found, but the meeting has AI action item candidates,
    // create Task records for them so the Kanban board isn't empty.
    try {
      if ((tasksMigratedCount || 0) === 0) {
        const candidateCount = meeting.actionItems && meeting.actionItems.length ? meeting.actionItems.length : 0;
        if (candidateCount > 0) {
          console.info(`No existing tasks; creating ${candidateCount} tasks from meeting.actionItems`);
          const createdTasks = [];
          for (const item of meeting.actionItems) {
            const t = await Task.create({
              userId: req.user.id,
              meetingId: meeting._id,
              boardId: board._id,
              source: 'ai',
              title: item.title || item.text || 'Untitled Task',
              description: item.description || '',
              priority: item.priority || 'medium',
              dueDate: item.dueDate || null,
              assignee: null,
            });
            createdTasks.push(t);
          }
          tasksMigratedCount = createdTasks.length;
          console.info(`Created ${createdTasks.length} tasks from actionItems`);
        }
      }
    } catch (err) {
      console.error('Error creating tasks from actionItems for meeting', meeting._id.toString(), err);
    }

    // Return populated board so client has owner/collaborator info immediately
    board = await Board.findById(board._id)
      .populate('userId', 'name email image')
      .populate('collaborators.user', 'name email image');

    // Prepare response: include fallback userId when populate returned null
    const boardObj = board.toObject();
    if (!boardObj.userId) {
      boardObj.userId = { _id: req.user.id, name: req.user?.name || 'Anda', image: req.user?.image || null };
    }

    // Determine requester role for convenience
    const isOwner = boardObj.userId && (boardObj.userId._id ? String(boardObj.userId._id) === req.user.id : String(boardObj.userId) === req.user.id);
    const isCollaborator = Array.isArray(boardObj.collaborators) && boardObj.collaborators.some(c => String(c.user?._id ?? c.user) === req.user.id);
    let userRole = 'viewer';
    if (isOwner) userRole = 'owner';
    else if (isCollaborator) {
      const col = boardObj.collaborators.find(c => String(c.user?._id ?? c.user) === req.user.id);
      if (col && col.role) userRole = col.role;
    }

    res.status(201).json({
      success: true,
      data: {
        ...boardObj,
        userRole,
      },
      tasksMigrated: tasksMigratedCount || 0,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.updateBoard = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, labels } = req.body;

    const board = await Board.findById(id);
    if (!board) return res.status(404).json({ success: false, message: 'Board not found' });

    // Permission check: Owner or Editor
    const isOwner = idEquals(board.userId, req.user.id);
    const col = board.collaborators.find(c => c && c.user && idEquals(c.user, req.user.id));
    const isEditor = col && (col.role === 'editor' || col.role === 'owner');

    if (!isOwner && !isEditor) {
      return res.status(403).json({ success: false, message: 'Only owners and editors can update board' });
    }

    if (title !== undefined) board.title = title;
    if (description !== undefined) board.description = description;
    
    if (labels !== undefined) {
      const oldLabels = board.labels || [];
      const newLabels = labels;
      
      // Update tasks if a label was renamed (identified by _id or id)
      for (const newL of newLabels) {
        const labelId = newL._id || newL.id;
        if (labelId) {
          const oldL = oldLabels.find(l => l._id?.toString() === labelId.toString() || l.id === labelId);
          if (oldL && oldL.name !== newL.name) {
            // Rename occurrences in tasks
            await Task.updateMany(
              { boardId: id, labels: oldL.name },
              { $set: { "labels.$": newL.name } }
            );
          }
        }
      }
      
      // Remove from tasks if a label was deleted
      for (const oldL of oldLabels) {
        const oldId = oldL._id || oldL.id;
        if (!newLabels.find(l => (l._id || l.id)?.toString() === oldId?.toString())) {
          // Delete occurrence from all tasks in this board
          await Task.updateMany(
            { boardId: id, labels: oldL.name },
            { $pull: { labels: oldL.name } }
          );
        }
      }

      board.labels = labels;
    }
    
    await board.save();

    const { emitToBoard } = require('../services/socketService');
    emitToBoard(id, 'board_updated', { 
      board, 
      userName: req.user.name || 'Collaborator',
      userId: req.user.id
    });

    res.json({ success: true, data: board });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * Sharing & Collaboration
 */
exports.generateShareLink = async (req, res) => {
  try {
    const board = await Board.findById(req.params.id);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found' });
    }

    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(board, currentUserId);

    if (!permission.canShare) {
      return res.status(403).json({ success: false, message: 'Only owners and admins can generate share links' });
    }

    if (!board.shareToken) {
      const maxRetries = 5;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        board.shareToken = nanoid(10);
        try {
          await board.save();
          break;
        } catch (err) {
          if (err && (err.code === 11000 || err.code === 11001)) {
            logger.warn(`Share token collision on attempt ${attempt + 1} for board ${board._id}, retrying`);
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
        shareToken: board.shareToken,
        shareUrl: `${frontendUrl}/dashboard/join/board/${board.shareToken}`
      }
    });
  } catch (error) {
    logger.error('generateShareLink error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.joinBoard = async (req, res) => {
  try {
    const { token } = req.params;
    const board = await Board.findOne({ shareToken: token });

    if (!board) {
      return res.status(404).json({ success: false, message: 'Invalid share link' });
    }

    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(board, currentUserId);

    // If user already has access, return their current role
    if (permission.canView) {
      const populated = await Board.findById(board._id)
        .populate('userId', 'name email image')
        .populate('collaborators.user', 'name email image');
      
      return res.json({
        success: true,
        message: permission.isOwner ? 'You are the owner of this board' : 'You are already a member of this board',
        data: {
          board: {
            _id: populated._id,
            id: populated._id,
            title: populated.title,
          },
          boardId: populated._id,
          role: permission.role,
          userRole: permission.role,
          alreadyMember: true,
        }
      });
    }

    // Add as viewer collaborator
    try {
      const updateResult = await Board.updateOne(
        { _id: board._id, 'collaborators.user': { $ne: currentUserId } },
        { $push: { collaborators: { user: currentUserId, role: COLLABORATOR_ROLES.VIEWER, joinedAt: new Date() } } }
      );

      if (updateResult && updateResult.modifiedCount > 0) {
        try {
          const { emitCollaboratorJoined } = require('../services/socketService');
          emitCollaboratorJoined('board', String(board._id), {
            id: currentUserId,
            name: req.user?.name || 'Anonymous',
            image: req.user?.image || null,
          }, COLLABORATOR_ROLES.VIEWER);
        } catch (e) {
          logger.warn('Failed to emit collaborator_joined after board join', e);
        }
      }
    } catch (e) {
      logger.warn('Failed to atomically add collaborator on joinBoard:', e?.message || e);
    }

    // Re-fetch and populate for response
    const populated = await Board.findById(board._id)
      .populate('userId', 'name email image')
      .populate('collaborators.user', 'name email image');

    res.json({
      success: true,
      message: 'Joined board successfully',
      data: {
        board: {
          _id: populated._id,
          id: populated._id,
          title: populated.title,
        },
        boardId: populated._id,
        role: COLLABORATOR_ROLES.VIEWER,
        userRole: COLLABORATOR_ROLES.VIEWER,
        alreadyMember: false,
      }
    });
  } catch (error) {
    logger.error('joinBoard error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.updateCollaboratorRole = async (req, res) => {
  try {
    const { id, odellollaboratorId } = req.params;
    const { role } = req.body;
    const collaboratorId = odellollaboratorId || req.params.userId;

    // Validate role
    if (!role || !isValidRole(role) || role === COLLABORATOR_ROLES.OWNER) {
      return res.status(400).json({ success: false, message: 'Invalid role. Allowed: admin, editor, viewer' });
    }

    const board = await Board.findById(id);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found' });
    }

    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(board, currentUserId);

    if (!permission.canManageCollaborators) {
      return res.status(403).json({ success: false, message: 'Only owners and admins can update roles' });
    }

    if (!canAssignRole(permission.role, role)) {
      return res.status(403).json({ success: false, message: 'You cannot assign this role level' });
    }

    const col = board.collaborators.find(c => c && c.user && idEquals(c.user, collaboratorId));
    if (!col) {
      return res.status(404).json({ success: false, message: 'Collaborator not found' });
    }

    col.role = role;
    await board.save();

    // Emit socket event
    try {
      const { emitCollaboratorRoleChanged } = require('../services/socketService');
      emitCollaboratorRoleChanged('board', String(board._id), collaboratorId, role);
    } catch (e) {
      logger.warn('Failed to emit role change event', e);
    }

    res.json({ success: true, message: 'Role updated', data: { collaboratorId, newRole: role } });
  } catch (error) {
    logger.error('updateCollaboratorRole error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.removeCollaborator = async (req, res) => {
  try {
    const { id, odellollaboratorId } = req.params;
    const collaboratorId = odellollaboratorId || req.params.userId;

    const board = await Board.findById(id);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found' });
    }

    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(board, currentUserId);
    const isSelfRemoval = idEquals(collaboratorId, currentUserId);

    if (!isSelfRemoval && !permission.canManageCollaborators) {
      return res.status(403).json({ success: false, message: 'Permission denied' });
    }

    const originalLength = board.collaborators.length;
    board.collaborators = board.collaborators.filter(c => !(c && c.user && idEquals(c.user, collaboratorId)));

    if (board.collaborators.length === originalLength) {
      return res.status(404).json({ success: false, message: 'Collaborator not found' });
    }

    await board.save();

    // Emit socket event
    try {
      const { emitCollaboratorRemoved } = require('../services/socketService');
      emitCollaboratorRemoved('board', String(board._id), collaboratorId);
    } catch (e) {
      logger.warn('Failed to emit collaborator removed event', e);
    }

    res.json({ success: true, message: 'Collaborator removed' });
  } catch (error) {
    logger.error('removeCollaborator error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.revokeShareLink = async (req, res) => {
  try {
    const board = await Board.findById(req.params.id);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found' });
    }

    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(board, currentUserId);

    if (!permission.canShare) {
      return res.status(403).json({ success: false, message: 'Only owners and admins can revoke share links' });
    }

    board.shareToken = undefined;
    await board.save();

    res.json({ success: true, message: 'Share link revoked' });
  } catch (error) {
    logger.error('revokeShareLink error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * Toggle pin status for a board (max 3 pinned per user)
 * POST /api/boards/:id/pin
 */
exports.togglePin = async (req, res) => {
  try {
    const board = await Board.findById(req.params.id);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found' });
    }

    const currentUserId = req.user?.id || req.user?._id;
    const permission = getResourcePermission(board, currentUserId);

    if (!permission.canView) {
      return res.status(403).json({ success: false, message: 'You do not have access to this board' });
    }

    // Initialize pinnedBy array if not exists
    if (!board.pinnedBy) {
      board.pinnedBy = [];
    }

    // Check if user already has this board pinned
    const existingPinIndex = board.pinnedBy.findIndex(
      pin => pin.user.toString() === currentUserId.toString()
    );
    const isCurrentlyPinned = existingPinIndex !== -1;
    const newPinnedState = !isCurrentlyPinned;

    // If trying to pin, check limit (max 3 total pinned boards for this user)
    if (newPinnedState) {
      const pinnedCount = await Board.countDocuments({
        'pinnedBy.user': currentUserId,
      });

      if (pinnedCount >= 3) {
        return res.status(400).json({
          success: false,
          message: 'Maximum 3 boards can be pinned. Unpin another board first.',
        });
      }

      // Add user to pinnedBy array
      board.pinnedBy.push({ user: currentUserId, pinnedAt: new Date() });
    } else {
      // Remove user from pinnedBy array
      board.pinnedBy.splice(existingPinIndex, 1);
    }

    await board.save();

    logger.info(`Board ${req.params.id} ${newPinnedState ? 'pinned' : 'unpinned'} by user ${currentUserId}`);

    res.json({
      success: true,
      message: `Board ${newPinnedState ? 'pinned' : 'unpinned'} successfully`,
      data: {
        id: board._id,
        pinned: newPinnedState,
        pinnedAt: newPinnedState ? board.pinnedBy.find(p => p.user.toString() === currentUserId.toString())?.pinnedAt : null,
      },
    });
  } catch (error) {
    logger.error('togglePin error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * Get all pinned boards for current user
 * GET /api/boards/pinned
 */
exports.getPinnedBoards = async (req, res) => {
  try {
    const currentUserId = req.user?.id || req.user?._id;

    const boards = await Board.find({
      'pinnedBy.user': currentUserId,
    })
      .sort({ 'pinnedBy.pinnedAt': -1 })
      .select('title pinnedBy createdAt meetingId userId collaborators shareToken')
      .populate('meetingId', 'title')
      .limit(3);

    // Transform to include user-specific pinned info and userRole
    const transformedBoards = boards.map(board => {
      const userPin = board.pinnedBy?.find(p => p.user.toString() === currentUserId.toString());
      
      // Determine user role
      let userRole = 'viewer';
      const isOwner = board.userId && board.userId.toString() === currentUserId.toString();
      if (isOwner) {
        userRole = 'owner';
      } else if (board.collaborators && Array.isArray(board.collaborators)) {
        const col = board.collaborators.find(c => c && c.user && c.user.toString() === currentUserId.toString());
        if (col && col.role) userRole = col.role;
      }
      
      return {
        _id: board._id,
        title: board.title,
        meetingId: board.meetingId,
        createdAt: board.createdAt,
        pinned: true,
        pinnedAt: userPin?.pinnedAt,
        userRole,
        shareToken: board.shareToken,
      };
    });

    res.json({
      success: true,
      count: transformedBoards.length,
      data: transformedBoards,
    });
  } catch (error) {
    logger.error('getPinnedBoards error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};
