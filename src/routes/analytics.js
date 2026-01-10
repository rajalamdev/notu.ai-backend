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

/**
 * @route   GET /api/analytics/global
 * @desc    Get global analytics overview
 * @access  Private
 */
router.get('/global', analyticsController.getGlobalAnalytics);

/**
 * @route   GET /api/analytics/meetings
 * @desc    Get detail analytics list (paginated, sortable)
 * @access  Private
 */
router.get('/meetings', analyticsController.getDetailAnalyticsList);

/**
 * @route   GET /api/analytics/meetings/:id/detail
 * @desc    Get individual meeting detail analytics
 * @access  Private
 */
router.get('/meetings/:id/detail', analyticsController.getMeetingDetailAnalytics);

module.exports = router;
