const mongoose = require('mongoose');
const Task = require('../models/Task');
const Board = require('../models/Board');
const { emitToBoard } = require('../services/socketService');
const logger = require('../utils/logger');

/**
 * Get all tasks for authenticated user
 * GET /api/tasks
 */
const getTasks = async (req, res) => {
  try {
    const { status, meetingId, priority } = req.query;
    const filter = { userId: req.user.id };
    
    if (status) filter.status = status;
    if (meetingId) filter.meetingId = meetingId;
    if (priority) filter.priority = priority;
    
    const tasks = await Task.find(filter)
      .populate('meetingId', 'title')
      .sort({ status: 1, order: 1, createdAt: -1 });
    
    res.json({
      success: true,
      data: tasks,
      count: tasks.length,
    });
  } catch (error) {
    logger.error('Get tasks error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get tasks',
      error: error.message,
    });
  }
};

/**
 * Get single task by ID
 * GET /api/tasks/:id
 */
const getTaskById = async (req, res) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user.id,
    }).populate('meetingId', 'title');
    
    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found',
      });
    }
    
    res.json({
      success: true,
      data: task,
    });
  } catch (error) {
    logger.error('Get task by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get task',
      error: error.message,
    });
  }
};

/**
 * Create new task
 * POST /api/tasks
 */
const createTask = async (req, res) => {
  try {
    const { title, description, status: rawStatus, priority, dueDate, assignee, labels, meetingId, boardId } = req.body;
    
    if (!title) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }

    // Access check
    if (boardId) {
      const board = await Board.findById(boardId);
      if (!board) return res.status(404).json({ success: false, message: 'Board not found' });
      
      const isOwner = board.userId.toString() === req.user.id;
      const col = board.collaborators.find(c => c.user && c.user.toString() === req.user.id);
      const isEditor = col && (col.role === 'editor' || col.role === 'owner');

      if (!isOwner && !isEditor) {
        return res.status(403).json({ success: false, message: 'Only owners and editors can create tasks' });
      }
    }

    // Status is already in correct format (in-progress)
    const status = rawStatus;
    
    // Get max order
    const query = { status: status || 'todo' };
    if (boardId) query.boardId = boardId;
    else query.userId = req.user.id;

    const maxOrderTask = await Task.findOne(query).sort({ order: -1 });
    const order = maxOrderTask ? maxOrderTask.order + 1 : 0;
    
    const task = await Task.create({
      userId: req.user.id,
      title,
      description,
      status: status || 'todo',
      priority: priority || 'medium',
      dueDate,
      assignee: (assignee && mongoose.Types.ObjectId.isValid(assignee)) ? assignee : null,
      labels: labels || [],
      meetingId,
      boardId,
      order,
    });
    
    logger.info(`Task created: ${task._id} by user ${req.user.id}`);
    
    if (boardId) {
      const populatedTask = await task.populate('assignee', 'name email image');
      emitToBoard(boardId, 'task_created', { 
        task: populatedTask, 
        userName: req.user.name || 'Collaborator',
        taskTitle: populatedTask.title,
        userId: req.user.id
      });
    }

    res.status(201).json({ success: true, data: task, message: 'Task created successfully' });
  } catch (error) {
    logger.error('Create task error:', error);
    res.status(500).json({ success: false, message: 'Failed to create task', error: error.message });
  }
};

/**
 * Update task
 * PATCH /api/tasks/:id
 */
const updateTask = async (req, res) => {
  try {
    const { title, description, status: rawStatus, priority, dueDate, assignee, labels, order } = req.body;
    
    // Verify access
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    let hasAccess = task.userId.toString() === req.user.id;
    if (!hasAccess && task.boardId) {
      const board = await Board.findById(task.boardId);
      if (board) {
        const col = board.collaborators.find(c => c.user && c.user.toString() === req.user.id);
        hasAccess = (board.userId.toString() === req.user.id) || (col && (col.role === 'editor' || col.role === 'owner'));
      }
    }

    if (!hasAccess) return res.status(403).json({ success: false, message: 'Only owners and editors can update tasks' });

    // Status is already in correct format (in-progress)
    const status = rawStatus;

    // Update fields
    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (status !== undefined) task.status = status;
    if (priority !== undefined) task.priority = priority;
    if (dueDate !== undefined) task.dueDate = dueDate;
    if (assignee !== undefined) {
      task.assignee = (assignee && mongoose.Types.ObjectId.isValid(assignee)) ? assignee : null;
    }
    if (labels !== undefined) task.labels = labels;
    if (order !== undefined) task.order = order;
    
    await task.save();
    
    logger.info(`Task updated: ${task._id}`);

    if (task.boardId) {
      const populatedTask = await Task.findById(task._id).populate('assignee', 'name email image');
      emitToBoard(task.boardId, 'task_updated', { 
        task: populatedTask, 
        userName: req.user.name || 'Collaborator',
        taskTitle: populatedTask.title,
        userId: req.user.id
      });
    }
    
    res.json({ success: true, data: task, message: 'Task updated successfully' });
  } catch (error) {
    logger.error('Update task error:', error);
    res.status(500).json({ success: false, message: 'Failed to update task', error: error.message });
  }
};

/**
 * Delete task
 * DELETE /api/tasks/:id
 */
const deleteTask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    // Only owner can delete tasks? Or Owner + Editor? Let's say Owner only for high-stakes actions, or Owner + Editor for board tasks.
    // User requested: "authorization access role yang belum jalan, contohnya delete task... masih bisa dilakukan oleh viewer only"
    // So let's restrict to Owner/Editor.
    let hasAccess = task.userId.toString() === req.user.id;
    if (!hasAccess && task.boardId) {
      const board = await Board.findById(task.boardId);
      if (board) {
        const col = board.collaborators.find(c => c.user && c.user.toString() === req.user.id);
        hasAccess = (board.userId.toString() === req.user.id) || (col && (col.role === 'editor' || col.role === 'owner'));
      }
    }

    if (!hasAccess) return res.status(403).json({ success: false, message: 'Only owners and editors can delete tasks' });

    const boardId = task.boardId;
    await Task.findByIdAndDelete(req.params.id);
    
    logger.info(`Task deleted: ${req.params.id}`);
    
    if (boardId) {
      emitToBoard(boardId, 'task_deleted', { 
        taskId: req.params.id, 
        taskTitle: task.title,
        userName: req.user.name || 'Collaborator',
        userId: req.user.id
      });
    }

    res.json({ success: true, message: 'Task deleted successfully' });
  } catch (error) {
    logger.error('Delete task error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete task', error: error.message });
  }
};

/**
 * Reorder tasks (for drag and drop in Kanban)
 * PATCH /api/tasks/reorder
 */
const reorderTasks = async (req, res) => {
  try {
    const { tasks, boardId } = req.body;
    
    if (!tasks || !Array.isArray(tasks)) {
      return res.status(400).json({ success: false, message: 'Tasks array is required' });
    }

    if (boardId) {
      const board = await Board.findById(boardId);
      if (!board) return res.status(404).json({ success: false, message: 'Board not found' });
      
      const isOwner = board.userId.toString() === req.user.id;
      const col = board.collaborators.find(c => c.user && c.user.toString() === req.user.id);
      const isEditor = col && (col.role === 'editor' || col.role === 'owner');

      if (!isOwner && !isEditor) {
        return res.status(403).json({ success: false, message: 'Only owners and editors can reorder tasks' });
      }
    }
    
    // Update all tasks - status format is already standardized
    await Promise.all(
      tasks.map(({ id, order, status }) => {
        return Task.findByIdAndUpdate(id, { order, status });
      })
    );
    
    logger.info(`Tasks reordered by user ${req.user.id}`);

    if (boardId) {
      emitToBoard(boardId, 'tasks_reordered', { 
        tasks, 
        userName: req.user.name || 'Collaborator',
        userId: req.user.id
      });
    }
    
    res.json({ success: true, message: 'Tasks reordered successfully' });
  } catch (error) {
    logger.error('Reorder tasks error:', error);
    res.status(500).json({ success: false, message: 'Failed to reorder tasks', error: error.message });
  }
};

/**
 * Get tasks grouped by status (for Kanban board)
 * GET /api/tasks/kanban
 */
const getKanbanTasks = async (req, res) => {
  try {
    const { boardId } = req.query;
    if (!boardId) return res.status(400).json({ success: false, message: 'Board ID required' });

    // Check board access
    const board = await Board.findById(boardId);
    if (!board) return res.status(404).json({ success: false, message: 'Board not found' });

    const isOwner = board.userId.toString() === req.user.id;
    const isCollaborator = board.collaborators.some(c => c.user && c.user.toString() === req.user.id);

    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ success: false, message: 'No access to this board' });
    }

    const filter = { boardId };
    const tasks = await Task.find(filter)
      .populate('meetingId', 'title')
      .populate('assignee', 'name email image')
      .sort({ order: 1, createdAt: -1 });
    
    const kanban = {
      todo: tasks.filter(t => t.status === 'todo'),
      'in-progress': tasks.filter(t => t.status === 'in-progress'),
      done: tasks.filter(t => t.status === 'done'),
    };
    
    res.json({
      success: true,
      data: kanban,
    });
  } catch (error) {
    logger.error('Get kanban tasks error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get kanban tasks',
      error: error.message,
    });
  }
};

module.exports = {
  getTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  reorderTasks,
  getKanbanTasks,
};
