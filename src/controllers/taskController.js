const Task = require('../models/Task');
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
const { title, description, status, priority, dueDate, assignee, tags, meetingId, boardId } = req.body;
    
    if (!title) {
      return res.status(400).json({
        success: false,
        message: 'Title is required',
      });
    }
    
    // Get max order for the status
    const maxOrderTask = await Task.findOne({ 
      userId: req.user.id, 
      status: status || 'todo' 
    }).sort({ order: -1 });
    
    const order = maxOrderTask ? maxOrderTask.order + 1 : 0;
    
    const task = await Task.create({
      userId: req.user.id,
      title,
      description,
      status: status || 'todo',
      priority: priority || 'medium',
      dueDate,
      assignee,
      tags,
      meetingId,
      meetingId,
      boardId,
      order,
    });
    
    logger.info(`Task created: ${task._id} by user ${req.user.id}`);
    
    res.status(201).json({
      success: true,
      data: task,
      message: 'Task created successfully',
    });
  } catch (error) {
    logger.error('Create task error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create task',
      error: error.message,
    });
  }
};

/**
 * Update task
 * PATCH /api/tasks/:id
 */
const updateTask = async (req, res) => {
  try {
    const { title, description, status, priority, dueDate, assignee, tags, order } = req.body;
    
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user.id,
    });
    
    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found',
      });
    }
    
    // Update fields
    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (status !== undefined) task.status = status;
    if (priority !== undefined) task.priority = priority;
    if (dueDate !== undefined) task.dueDate = dueDate;
    if (assignee !== undefined) task.assignee = assignee;
    if (tags !== undefined) task.tags = tags;
    if (order !== undefined) task.order = order;
    
    await task.save();
    
    logger.info(`Task updated: ${task._id}`);
    
    res.json({
      success: true,
      data: task,
      message: 'Task updated successfully',
    });
  } catch (error) {
    logger.error('Update task error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update task',
      error: error.message,
    });
  }
};

/**
 * Delete task
 * DELETE /api/tasks/:id
 */
const deleteTask = async (req, res) => {
  try {
    const task = await Task.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id,
    });
    
    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found',
      });
    }
    
    logger.info(`Task deleted: ${req.params.id}`);
    
    res.json({
      success: true,
      message: 'Task deleted successfully',
    });
  } catch (error) {
    logger.error('Delete task error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete task',
      error: error.message,
    });
  }
};

/**
 * Reorder tasks (for drag and drop in Kanban)
 * PATCH /api/tasks/reorder
 */
const reorderTasks = async (req, res) => {
  try {
    const { tasks } = req.body;
    
    if (!tasks || !Array.isArray(tasks)) {
      return res.status(400).json({
        success: false,
        message: 'Tasks array is required',
      });
    }
    
    // Update all tasks in parallel
    await Promise.all(
      tasks.map(({ id, order, status }) =>
        Task.findOneAndUpdate(
          { _id: id, userId: req.user.id },
          { order, status }
        )
      )
    );
    
    logger.info(`Tasks reordered by user ${req.user.id}`);
    
    res.json({
      success: true,
      message: 'Tasks reordered successfully',
    });
  } catch (error) {
    logger.error('Reorder tasks error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reorder tasks',
      error: error.message,
    });
  }
};

/**
 * Get tasks grouped by status (for Kanban board)
 * GET /api/tasks/kanban
 */
const getKanbanTasks = async (req, res) => {
  try {
    const { boardId } = req.query;
    const filter = { userId: req.user.id };
    if (boardId) filter.boardId = boardId;

    const tasks = await Task.find(filter)
      .populate('meetingId', 'title')
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
