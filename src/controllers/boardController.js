const Board = require('../models/Board');
const Task = require('../models/Task');
const Meeting = require('../models/Meeting');
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

    // Access check
    const isOwner = board.userId && board.userId._id.toString() === req.user.id;
    const isCollaborator = board.collaborators.some(c => c.user && c.user._id.toString() === req.user.id);

    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ success: false, message: 'Unauthorized access to board' });
    }

    // Get role
    let userRole = 'viewer';
    if (isOwner) userRole = 'owner';
    else if (isCollaborator) {
      userRole = board.collaborators.find(c => c.user._id.toString() === req.user.id).role;
    }

    res.json({ 
      success: true, 
      data: {
        ...board.toObject(),
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

exports.createFromMeeting = async (req, res) => {
  try {
    // Accept either { meetingId: 'id' } or plain string in body
    let meetingIdRaw = req.body && req.body.meetingId !== undefined ? req.body.meetingId : req.body
    if (!meetingIdRaw) {
      return res.status(400).json({ success: false, message: 'Meeting ID required' });
    }

    const meetingId = (typeof meetingIdRaw === 'object' && meetingIdRaw.meetingId) ? meetingIdRaw.meetingId : meetingIdRaw

    // Allow owners or collaborators to create/migrate a board
    const meeting = await Meeting.findOne({
      _id: meetingId,
      $or: [
        { userId: req.user.id },
        { 'collaborators.user': req.user.id }
      ]
    });
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found or access denied' });
    }

    // Check if board already exists for this meeting
    let board = await Board.findOne({ meetingId: meeting._id });
    
    if (!board) {
      // Create Board
      board = await Board.create({
        userId: req.user.id,
        meetingId: meeting._id,
        title: meeting.title || 'Untitled Meeting Kanban',
        description: `Generated from meeting on ${new Date(meeting.createdAt).toLocaleDateString()}`,
        source: 'ai'
      });
    }

    // Update Tasks - also include those where user is collaborator if appropriate
    // But usually migration is initiated by owner
    const updated = await Task.updateMany(
      { meetingId: meeting._id, userId: req.user.id },
      { $set: { boardId: board._id, source: 'ai' } }
    );

    res.status(201).json({ 
      success: true, 
      data: board,
      tasksMigrated: updated.modifiedCount 
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
    const isOwner = board.userId.toString() === req.user.id;
    const col = board.collaborators.find(c => c.user && c.user.toString() === req.user.id);
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
      board.shareToken = nanoid(10);
      await board.save();
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

    const isOwner = board.userId.toString() === req.user.id;
    const isCollaborator = board.collaborators.some(c => c.user && c.user.toString() === req.user.id);

    if (!isOwner && !isCollaborator) {
      board.collaborators.push({
        user: req.user.id,
        role: COLLABORATOR_ROLES.VIEWER
      });
      await board.save();
    }

    res.json({
      success: true,
      message: 'Joined board successfully',
      data: { boardId: board._id }
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

    const col = board.collaborators.find(c => c.user && c.user.toString() === userId);
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

    board.collaborators = board.collaborators.filter(c => c.user && c.user.toString() !== userId);
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
