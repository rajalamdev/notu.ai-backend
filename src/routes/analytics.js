const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { authenticate } = require('../middleware/auth');

// All analytics routes require authentication
router.use(authenticate);

/**
 * @route   GET /api/analytics/stats
 * @desc    Get dashboard statistics
 * @access  Private
 */
router.get('/stats', analyticsController.getStats);

/**
 * @route   GET /api/analytics/trends
 * @desc    Get meeting trends over time
 * @access  Private
 */
router.get('/trends', analyticsController.getTrends);

/**
 * @route   GET /api/analytics/platforms
 * @desc    Get platform distribution
 * @access  Private
 */
router.get('/platforms', analyticsController.getPlatformStats);

/**
 * @route   GET /api/analytics/activity
 * @desc    Get recent activity
 * @access  Private
 */
router.get('/activity', analyticsController.getRecentActivity);

module.exports = router;
