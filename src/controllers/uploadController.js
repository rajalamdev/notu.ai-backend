const fs = require('fs');
const Meeting = require('../models/Meeting');
const { storeFile, cleanupTempFile } = require('../services/storageService');
const { addTranscriptionJob } = require('../services/queueService');
const { checkHealth: checkWhisperHealth } = require('../services/whisperxService');
const { MEETING_STATUS, MEETING_TYPE, PLATFORM } = require('../utils/constants');
const logger = require('../utils/logger');

/**
 * Upload audio/video file for transcription
 */
async function uploadMeeting(req, res, next) {
  let tempFilePath = null;

  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
        message: 'Please upload an audio or video file',
      });
    }

    const { title, description, tags } = req.body;
    tempFilePath = req.file.path;

    logger.info(`Processing upload: ${req.file.originalname}`);

    // Upload file to MinIO
    const fileStream = fs.createReadStream(tempFilePath);
    const fileInfo = await storeFile(fileStream, req.file.originalname, {
      mimetype: req.file.mimetype,
    });

    // Create meeting record in database
    const meeting = await Meeting.create({
      userId: req.user.id,
      title: title || `Meeting - ${new Date().toLocaleDateString()}`,
      description: description || '',
      platform: PLATFORM.UPLOAD,
      type: MEETING_TYPE.UPLOAD,
      status: MEETING_STATUS.PENDING,
      tags: tags ? (Array.isArray(tags) ? tags : [tags]) : [],
      originalFile: {
        filename: fileInfo.filename,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: fileInfo.path,
        uploadedAt: new Date(),
      },
    });

    // Clean up temporary file
    cleanupTempFile(tempFilePath);

    // Check WhisperX health before enqueueing
    const whisperHealth = await checkWhisperHealth();
    if (whisperHealth.status === 'unhealthy') {
      logger.warn('WhisperX service is unhealthy, but still enqueueing job for later processing');
    }

    // Add transcription job to queue
    await addTranscriptionJob(meeting._id.toString(), {
      priority: 5,
    });

    logger.info(`Meeting created and queued for transcription: ${meeting._id}`);

    res.status(201).json({
      success: true,
      message: 'File uploaded successfully and queued for transcription',
      meeting: {
        _id: meeting._id,
        title: meeting.title,
        status: meeting.status,
        platform: meeting.platform,
        createdAt: meeting.createdAt,
        filename: fileInfo.originalName,
        size: req.file.size,
        uploadedAt: meeting.originalFile.uploadedAt,
      },
    });
  } catch (error) {
    // Clean up temporary file on error
    if (tempFilePath) {
      cleanupTempFile(tempFilePath);
    }
    
    logger.error('Upload error:', error);
    next(error);
  }
}

module.exports = {
  uploadMeeting,
};
