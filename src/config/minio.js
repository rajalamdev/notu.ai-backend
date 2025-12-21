const Minio = require('minio');
const config = require('./env');
const logger = require('../utils/logger');

let minioClient = null;

function createMinioClient() {
  if (minioClient) {
    return minioClient;
  }

  minioClient = new Minio.Client({
    endPoint: config.MINIO.endPoint,
    port: config.MINIO.port,
    useSSL: config.MINIO.useSSL,
    accessKey: config.MINIO.accessKey,
    secretKey: config.MINIO.secretKey,
  });

  logger.info('MinIO client initialized');
  return minioClient;
}

function getMinioClient() {
  if (!minioClient) {
    return createMinioClient();
  }
  return minioClient;
}

/**
 * Ensure bucket exists, create if it doesn't
 */
async function ensureBucket() {
  const client = getMinioClient();
  const bucketName = config.MINIO.bucket;

  try {
    const exists = await client.bucketExists(bucketName);
    
    if (!exists) {
      await client.makeBucket(bucketName, 'us-east-1');
      logger.info(`MinIO bucket created: ${bucketName}`);
      
      // Set bucket policy for public read access
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${bucketName}/*`],
          },
        ],
      };
      
      await client.setBucketPolicy(bucketName, JSON.stringify(policy));
      logger.info(`MinIO bucket policy set for: ${bucketName}`);
    } else {
      logger.info(`MinIO bucket already exists: ${bucketName}`);
    }
  } catch (error) {
    logger.error('Error ensuring MinIO bucket:', error);
    throw error;
  }
}

/**
 * Upload file stream to MinIO
 */
async function uploadFile(stream, filename, metadata = {}) {
  const client = getMinioClient();
  const bucketName = config.MINIO.bucket;

  try {
    await client.putObject(bucketName, filename, stream, metadata);
    logger.info(`File uploaded to MinIO: ${filename}`);
    return {
      bucket: bucketName,
      filename,
      path: `${bucketName}/${filename}`,
    };
  } catch (error) {
    logger.error('Error uploading file to MinIO:', error);
    throw error;
  }
}

/**
 * Download file from MinIO
 */
async function downloadFile(filename) {
  const client = getMinioClient();
  const bucketName = config.MINIO.bucket;

  try {
    const stream = await client.getObject(bucketName, filename);
    logger.info(`File downloaded from MinIO: ${filename}`);
    return stream;
  } catch (error) {
    logger.error('Error downloading file from MinIO:', error);
    throw error;
  }
}

/**
 * Delete file from MinIO
 */
async function deleteFile(filename) {
  const client = getMinioClient();
  const bucketName = config.MINIO.bucket;

  try {
    await client.removeObject(bucketName, filename);
    logger.info(`File deleted from MinIO: ${filename}`);
  } catch (error) {
    logger.error('Error deleting file from MinIO:', error);
    throw error;
  }
}

/**
 * Get presigned URL for file access
 */
async function getPresignedUrl(filename, expirySeconds = 3600) {
  const client = getMinioClient();
  const bucketName = config.MINIO.bucket;

  try {
    const url = await client.presignedGetObject(bucketName, filename, expirySeconds);
    return url;
  } catch (error) {
    logger.error('Error generating presigned URL:', error);
    throw error;
  }
}

module.exports = {
  createMinioClient,
  getMinioClient,
  ensureBucket,
  uploadFile,
  downloadFile,
  deleteFile,
  getPresignedUrl,
};
