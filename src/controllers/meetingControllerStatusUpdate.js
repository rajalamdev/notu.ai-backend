const Meeting = require('../models/Meeting');
const logger = require('../utils/logger');

// Import all functions from the main controller
const mainController = require('./meetingController');

/**
 * Update meeting status (for bot service)
 * PATCH /api/meetings/:id/status
 */
async function updateMeetingStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status, ...data } = req.body;
    
    const meeting = await Meeting.findById(id);
    if (!meeting) {
      return res.status(404).json({
        success: false,
        error: 'Meeting not found',
      });
    }
    
    // Update status
    if (status) {
      meeting.status = status;
    }
    
    // Update additional data
    Object.assign(meeting, data);
    
    await meeting.save();
    
    logger.info(`Meeting status updated: ${id} -> ${status}`);
    
    res.json({
      success: true,
      message: 'Meeting status updated',
    });
  } catch (error) {
    logger.error('Error updating meeting status:', error);
    next(error);
  }
}

// Re-export all functions from main controller and add updateMeetingStatus
module.exports = {
  ...mainController,
  updateMeetingStatus,
};
