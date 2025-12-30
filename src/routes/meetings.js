const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validator');
const { authenticate, optionalAuth } = require('../middleware/auth');
const {
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
} = require('../controllers/meetingController');

const router = express.Router();

/**
 * GET /api/meetings
 * Get all meetings with pagination
 */
router.get('/', optionalAuth, asyncHandler(getAllMeetings));

/**
 * POST /api/meetings
 * Create new meeting
 */
router.post('/', authenticate, asyncHandler(createMeeting));

/**
 * POST /api/meetings/online
 * Create online meeting and start bot
 */
router.post('/online', authenticate, asyncHandler(createOnlineMeeting));

/**
 * GET /api/meetings/:id
 * Get meeting by ID
 */
router.get('/:id', optionalAuth, asyncHandler(getMeetingById));

/**
 * GET /api/meetings/:id/status
 * Get meeting processing status
 */
router.get('/:id/status', optionalAuth, asyncHandler(getMeetingStatus));

/**
 * POST /api/meetings/:id/retry
 * Retry failed transcription
 */
router.post('/:id/retry', authenticate, asyncHandler(retryTranscription));
router.post('/:id/regenerate-ai', authenticate, asyncHandler(regenerateMetadata));

/**
 * PATCH /api/meetings/:id
 * Update meeting
 */
router.patch(
  '/:id',
  authenticate,
  validate(schemas.updateMeeting),
  asyncHandler(updateMeeting)
);

/**
 * DELETE /api/meetings/:id
 * Delete meeting
 */
router.delete('/:id', authenticate, asyncHandler(deleteMeeting));

/**
 * GET /api/meetings/:id/export
 * Export transcript as plain text
 */
router.get('/:id/export', optionalAuth, asyncHandler(exportTranscript));

/**
 * GET /api/meetings/:id/analytics
 * Get meeting analytics (talktime, topics/keywords)
 */
router.get('/:id/analytics', optionalAuth, asyncHandler(getMeetingAnalytics));

/**
 * Collaboration & Sharing
 */
router.post('/:id/share', authenticate, asyncHandler(generateShareLink));
router.post('/join/:token', authenticate, asyncHandler(joinMeeting));
router.delete('/:id/share', authenticate, asyncHandler(revokeShareLink));
router.patch('/:id/collaborators/:userId', authenticate, asyncHandler(updateCollaboratorRole));
router.delete('/:id/collaborators/:userId', authenticate, asyncHandler(removeCollaborator));
router.patch('/:id/segments/speaker', authenticate, asyncHandler(updateSpeakerName));

module.exports = router;
