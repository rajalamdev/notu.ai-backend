// @ts-nocheck
const Board = require('../models/Board');
const Task = require('../models/Task');
const Meeting = require('../models/Meeting');
const { idEquals } = require('../utils/idEquals');
const User = require('../models/User');
const crypto = require('crypto');
const nanoid = (size = 10) => crypto.randomBytes(size).toString('hex').slice(0, size);
const { COLLABORATOR_ROLES } = require('../utils/constants');

exports.getBoards = async (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 12;
    const skip = (page - 1) * limit;
    const search = req.query.search;

    let query = {};

    if (filter === 'mine') {
      query.userId = req.user.id;
    } else if (filter === 'shared') {
      query['collaborators.user'] = req.user.id;
      query.userId = { $ne: req.user.id };
    } else {
      query.$or = [
        { userId: req.user.id },
        { 'collaborators.user': req.user.id }
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

    const boards = await Board.find(query)
      .populate('userId', 'name email image')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Board.countDocuments(query);

    res.json({
      success: true,
      count: boards.length,
      data: boards,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      }
    });
  } catch (error) {
    console.error(error);
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

    // Permission: allow deletion by board owner, a collaborator, or the meeting owner (if tied to a meeting).
    const isOwner = idEquals(board.userId, req.user.id);
    const isCollaborator = Array.isArray(board.collaborators) && board.collaborators.some(c => c && c.user && idEquals(c.user, req.user.id));

    let isMeetingOwner = false;
    if (!isOwner && board.meetingId) {
      try {
        const meeting = await Meeting.findById(board.meetingId);
        if (meeting && String(meeting.userId) === String(req.user.id)) {
          isMeetingOwner = true;
        }
      } catch (e) {
        // ignore lookup errors and fall through to permission check
      }
    }

    if (!isOwner && !isCollaborator && !isMeetingOwner) {
      return res.status(403).json({ success: false, message: 'Only owner can delete board' });
    }

    // Unset boardId from tasks rather than deleting tasks
    await Task.updateMany({ boardId: board._id }, { $unset: { boardId: "" } });

    await board.deleteOne();

    res.json({ success: true, message: 'Board deleted' });
  } catch (error) {
    console.error(error);
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
    const board = await Board.findOne({ _id: req.params.id, userId: req.user.id });
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found' });
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
            console.warn(`Share token collision on attempt ${attempt + 1} for board ${board._id}, retrying`);
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

    // Normalize ids for robust comparison
    const reqUserIdStr = String(req.user?.id || req.user?._id || '');
    const boardOwnerIdStr = (board.userId && board.userId._id) ? String(board.userId._id) : String(board.userId);
    const isOwner = !!(reqUserIdStr && boardOwnerIdStr === reqUserIdStr);
    const isCollaborator = Array.isArray(board.collaborators) && board.collaborators.some(c => {
      try {
        const uid = (c && c.user && c.user._id) ? String(c.user._id) : String(c && c.user);
        return uid === reqUserIdStr;
      } catch (e) { return false; }
    });

    if (!isOwner && !isCollaborator) {
      try {
        const updateResult = await Board.updateOne(
          { _id: board._id, 'collaborators.user': { $ne: req.user.id } },
          { $push: { collaborators: { user: req.user.id, role: COLLABORATOR_ROLES.VIEWER, joinedAt: new Date() } } }
        );

        if (!(updateResult && updateResult.modifiedCount && updateResult.modifiedCount > 0)) {
          // nothing modified: collaborator likely already present — continue
        }
      } catch (e) {
        console.warn('Failed to atomically add collaborator on joinBoard:', e?.message || e);
      }
    }

    // Re-fetch and populate so clients get the latest collaborator list and owner info
    const populated = await Board.findById(board._id)
      .populate('userId', 'name email image')
      .populate('collaborators.user', 'name email image');

    const boardObj = populated ? populated.toObject() : board.toObject();

    // Backfill collaborator user display fields when populate failed or returned partial objects
    try {
      const collabs = Array.isArray(boardObj.collaborators) ? boardObj.collaborators : [];
      const missingUserIds = collabs
        .map(c => c && (c.user?._id ? String(c.user._id) : (c.user ? String(c.user) : null)))
        .filter(Boolean)
        .filter(id => {
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
          return { ...c, user: { _id: uid, name: c.user && c.user.name ? c.user.name : 'Unknown', image: c.user && c.user.image ? c.user.image : null } };
        });
      }
    } catch (e) {
      console.warn('Failed to backfill board collaborators after joinBoard', e?.message || e);
    }

    // Compute requester role
    const isOwnerAfter = boardObj.userId && (boardObj.userId._id ? String(boardObj.userId._id) === req.user.id : String(boardObj.userId) === req.user.id);
    const isCollaboratorAfter = Array.isArray(boardObj.collaborators) && boardObj.collaborators.some(c => String(c.user?._id ?? c.user) === req.user.id);
    let userRoleAfter = 'viewer';
    if (isOwnerAfter) userRoleAfter = 'owner';
    else if (isCollaboratorAfter) {
      const col = boardObj.collaborators.find(c => String(c.user?._id ?? c.user) === req.user.id);
      if (col && col.role) userRoleAfter = col.role;
    }

    // Emit update so owners currently viewing will see the new collaborator (best-effort)
    try {
      const { emitToBoard } = require('../services/socketService');
      emitToBoard(String(board._id), 'board_updated', {
        board: boardObj,
        userName: req.user.name || 'Collaborator',
        userId: req.user.id
      });
    } catch (e) {
      console.warn('Socket emit failed after joinBoard', e);
    }

    res.json({
      success: true,
      message: 'Joined board successfully',
      data: {
        board: boardObj,
        userRole: userRoleAfter,
        boardId: board._id
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.updateCollaboratorRole = async (req, res) => {
  try {
    const { id, userId } = req.params;
    const { role } = req.body;

    const board = await Board.findOne({ _id: id, userId: req.user.id });
    if (!board) return res.status(404).json({ success: false, message: 'Board not found' });

    const col = board.collaborators.find(c => c && c.user && idEquals(c.user, userId));
    if (!col) return res.status(404).json({ success: false, message: 'Collaborator not found' });

    col.role = role;
    await board.save();

    res.json({ success: true, message: 'Role updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.removeCollaborator = async (req, res) => {
  try {
    const { id, userId } = req.params;
    const board = await Board.findOne({ _id: id, userId: req.user.id });
    if (!board) return res.status(404).json({ success: false, message: 'Board not found' });

    board.collaborators = board.collaborators.filter(c => !(c && c.user && idEquals(c.user, userId)));
    await board.save();

    res.json({ success: true, message: 'Collaborator removed' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.revokeShareLink = async (req, res) => {
  try {
    const board = await Board.findOne({ _id: req.params.id, userId: req.user.id });
    if (!board) return res.status(404).json({ success: false, message: 'Board not found' });

    board.shareToken = undefined;
    await board.save();

    res.json({ success: true, message: 'Share link revoked' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};
