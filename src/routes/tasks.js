const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');
const { authenticate } = require('../middleware/auth');

// All task routes require authentication
router.use(authenticate);

/**
 * @route   GET /api/tasks
 * @desc    Get all tasks for authenticated user
 * @access  Private
 */
router.get('/', taskController.getTasks);

/**
 * @route   GET /api/tasks/kanban
 * @desc    Get tasks grouped by status for Kanban board
 * @access  Private
 */
router.get('/kanban', taskController.getKanbanTasks);

/**
 * @route   GET /api/tasks/:id
 * @desc    Get single task by ID
 * @access  Private
 */
router.get('/:id', taskController.getTaskById);

/**
 * @route   POST /api/tasks
 * @desc    Create new task
 * @access  Private
 */
router.post('/', taskController.createTask);

/**
 * @route   PATCH /api/tasks/reorder
 * @desc    Reorder tasks (for Kanban drag and drop)
 * @access  Private
 */
router.patch('/reorder', taskController.reorderTasks);

/**
 * @route   PATCH /api/tasks/:id
 * @desc    Update task
 * @access  Private
 */
router.patch('/:id', taskController.updateTask);

/**
 * @route   DELETE /api/tasks/:id
 * @desc    Delete task
 * @access  Private
 */
router.delete('/:id', taskController.deleteTask);

module.exports = router;
