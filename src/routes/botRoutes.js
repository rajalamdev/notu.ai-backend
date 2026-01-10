/**
 * Bot Routes
 * 
 * REST API endpoints for bot control
 */

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate, optionalAuth } = require('../middleware/auth');
const {
  startBot,
  stopBot,
  getBotStatus,
  receiveSegments,
  finalizeBotSession,
  getAllSessions,
} = require('../controllers/botController');

const router = express.Router();

/**
 * POST /api/bot/join
 * Start a bot to join a meeting
 */
router.post('/join', authenticate, asyncHandler(startBot));

/**
 * POST /api/bot/:meetingId/stop
 * Stop a bot session
 */
router.post('/:meetingId/stop', authenticate, asyncHandler(stopBot));

/**
 * GET /api/bot/:meetingId/status
 * Get bot session status
 */
router.get('/:meetingId/status', optionalAuth, asyncHandler(getBotStatus));

/**
 * POST /api/bot/:meetingId/segments
 * Receive segments from bot service (internal use)
 */
router.post('/:meetingId/segments', asyncHandler(receiveSegments));

/**
 * POST /api/bot/:meetingId/finalize
 * Finalize bot session (internal use)
 */
router.post('/:meetingId/finalize', asyncHandler(finalizeBotSession));

/**
 * GET /api/bot/sessions
 * Get all active bot sessions
 */
router.get('/sessions', authenticate, asyncHandler(getAllSessions));

module.exports = router;
