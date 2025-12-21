const fs = require('fs');
const path = require('path');
const { uploadFile, downloadFile, deleteFile, getPresignedUrl } = require('../config/minio');
const logger = require('../utils/logger');
const { generateUniqueFilename } = require('../utils/helpers');

/**
 * Upload file stream to MinIO storage
 */
async function storeFile(stream, originalFilename, metadata = {}) {
  try {
    const uniqueFilename = generateUniqueFilename(originalFilename);
    
    const result = await uploadFile(stream, uniqueFilename, {
      'Content-Type': metadata.mimetype || 'application/octet-stream',
      'Original-Name': originalFilename,
    });

    logger.info(`File stored successfully: ${uniqueFilename}`);
    
    return {
      filename: uniqueFilename,
      originalName: originalFilename,
      path: result.path,
      bucket: result.bucket,
    };
  } catch (error) {
    logger.error('Error storing file:', error);
    throw new Error(`Failed to store file: ${error.message}`);
  }
}

/**
 * Retrieve file stream from MinIO storage
 */
async function retrieveFile(filename) {
  try {
    const stream = await downloadFile(filename);
    logger.info(`File retrieved successfully: ${filename}`);
    return stream;
  } catch (error) {
    logger.error('Error retrieving file:', error);
    throw new Error(`Failed to retrieve file: ${error.message}`);
  }
}

/**
 * Get file stream for download (alias for retrieveFile)
 */
async function getFileStream(filename) {
  return retrieveFile(filename);
}

/**
 * Delete file from MinIO storage
 */
async function removeFile(filename) {
  try {
    await deleteFile(filename);
    logger.info(`File deleted successfully: ${filename}`);
  } catch (error) {
    logger.error('Error deleting file:', error);
    throw new Error(`Failed to delete file: ${error.message}`);
  }
}

/**
 * Get public URL for file
 */
async function getFileUrl(filename, expirySeconds = 3600) {
  try {
    const url = await getPresignedUrl(filename, expirySeconds);
    return url;
  } catch (error) {
    logger.error('Error getting file URL:', error);
    throw new Error(`Failed to get file URL: ${error.message}`);
  }
}

/**
 * Clean up temporary uploaded files
 */
function cleanupTempFile(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      logger.info(`Temporary file deleted: ${filepath}`);
    }
  } catch (error) {
    logger.error('Error cleaning up temp file:', error);
  }
}

module.exports = {
  storeFile,
  retrieveFile,
  getFileStream,
  removeFile,
  getFileUrl,
  cleanupTempFile,
};
