const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Extract audio from video file and convert to WAV
 * @param {string} videoPath - Path to video file (.webm)
 * @param {string} outputPath - Path for output audio (.wav)
 * @returns {Promise<string>} Path to extracted audio file
 */
async function extractAudioFromVideo(videoPath, outputPath) {
    return new Promise((resolve, reject) => {
        logger.info(`[VideoService] Extracting audio from: ${videoPath}`);
        
        ffmpeg(videoPath)
            .noVideo() // Remove video track
            .audioCodec('pcm_s16le') // WAV format (uncompressed PCM 16-bit little-endian)
            .audioChannels(1) // Mono (Whisper prefers mono)
            .audioFrequency(16000) // 16kHz (Whisper's native sample rate)
            .output(outputPath)
            .on('start', (cmd) => {
                logger.debug(`[VideoService] FFmpeg command: ${cmd}`);
            })
            .on('progress', (progress) => {
                if (progress.percent) {
                    logger.debug(`[VideoService] Extraction progress: ${Math.round(progress.percent)}%`);
                }
            })
            .on('end', () => {
                const size = fs.statSync(outputPath).size;
                logger.info(`[VideoService] Audio extracted successfully: ${(size / 1024 / 1024).toFixed(2)} MB`);
                resolve(outputPath);
            })
            .on('error', (err) => {
                logger.error(`[VideoService] FFmpeg error: ${err.message}`);
                reject(err);
            })
            .run();
    });
}

/**
 * Get video duration in seconds
 * @param {string} videoPath - Path to video file
 * @returns {Promise<number>} Duration in seconds
 */
async function getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                logger.error(`[VideoService] Failed to probe video: ${err.message}`);
                reject(err);
            } else {
                const duration = metadata.format.duration || 0;
                resolve(duration);
            }
        });
    });
}

module.exports = {
    extractAudioFromVideo,
    getVideoDuration,
};
