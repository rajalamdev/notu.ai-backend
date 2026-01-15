const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const config = require('../config/env');
const logger = require('../utils/logger');
const { extractAudioFromVideo, getVideoDuration } = require('./videoService');

// Configure ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Process video recording for a meeting (POC)
 * 1. Find video file from Playwright recording
 * 2. Extract audio using FFmpeg
 * 3. Send to Whisper for transcription
 */
exports.processMeetingVideo = async (meetingId) => {
  const videoDir = path.join(process.cwd(), 'uploads', 'videos');
  const outputDir = path.join(process.cwd(), 'uploads', 'meetings');
  
  // Ensure directories exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Find video file (may have timestamp suffix from Playwright)
  let videoFile = path.join(videoDir, `${meetingId}.webm`);
  
  if (!fs.existsSync(videoFile)) {
    // Try to find any video file with meetingId prefix
    const files = fs.existsSync(videoDir) ? fs.readdirSync(videoDir) : [];
    const matchingFile = files.find(f => f.startsWith(meetingId) && f.endsWith('.webm'));
    
    if (matchingFile) {
      videoFile = path.join(videoDir, matchingFile);
    } else {
      throw new Error(`Video file not found for meeting ${meetingId}`);
    }
  }
  
  logger.info(`[AudioService] Processing video: ${videoFile}`);
  
  // Extract audio to WAV
  const audioFile = path.join(outputDir, `${meetingId}.wav`);
  await extractAudioFromVideo(videoFile, audioFile);
  
  // Get video duration
  const duration = await getVideoDuration(videoFile);
  logger.info(`[AudioService] Video duration: ${duration.toFixed(2)}s`);
  
  // Send to Whisper
  logger.info(`[AudioService] Sending audio to WhisperX...`);
  
  const form = new FormData();
  form.append('file', fs.createReadStream(audioFile));
  form.append('num_speakers', '2'); // Default
  
  const response = await axios.post(
    `${config.WHISPERX_API_URL}/transcribe`,
    form,
    {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 1800000, // 30 minutes
    }
  );
  
  logger.info(`[AudioService] WhisperX transcription completed`);
  
  return {
    transcription: response.data,
    audioPath: `/uploads/meetings/${meetingId}.wav`,
    videoPath: `/uploads/videos/${path.basename(videoFile)}`,
    duration: response.data.duration || duration,
  };
};

/**
 * Process audio chunks for a meeting
 * 1. Merge chunks into single file
 * 2. Send to Whisper for transcription
 * 3. Return full result
 */
exports.processMeetingAudio = async (meetingId) => {
  const chunksDir = path.join(process.cwd(), 'uploads', 'audio_chunks', meetingId);
  const outputDir = path.join(process.cwd(), 'uploads', 'meetings');
  const outputFile = path.join(outputDir, `${meetingId}.webm`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Check if chunks exist
  if (!fs.existsSync(chunksDir)) {
    throw new Error(`No audio chunks found for meeting ${meetingId}`);
  }

  // Get all chunk files and sort them
  const files = fs.readdirSync(chunksDir)
    .filter(f => f.endsWith('.webm'))
    .sort((a, b) => {
      // Sort by index (filename format: 00001.webm or index_timestamp.webm)
      const parseIndex = (name) => parseInt(name.split('_')[0]) || parseInt(name.split('.')[0]) || 0;
      return parseIndex(a) - parseIndex(b);
    });

  if (files.length === 0) {
    throw new Error(`No .webm files found in ${chunksDir}`);
  }

  logger.info(`[AudioService] Found ${files.length} chunks for meeting ${meetingId}`);

  // Create concat list file
  const listFile = path.join(chunksDir, 'concat_list.txt');
  const fileContent = files.map(f => `file '${path.join(chunksDir, f).replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(listFile, fileContent);

  // Merge files using ffmpeg concat demuxer
  logger.info(`[AudioService] Merging chunks to ${outputFile}...`);
  
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy']) // Stream copy (fast, no re-encoding)
      .output(outputFile)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });

  logger.info(`[AudioService] Merge complete. File size: ${fs.statSync(outputFile).size} bytes`);

  // Cleanup chunks (optional - maybe keep for backup?)
  // fs.rmSync(chunksDir, { recursive: true, force: true });

  // Send to Whisper
  logger.info(`[AudioService] Sending to WhisperX at ${config.WHISPERX_API_URL}...`);
  
  const form = new FormData();
  form.append('file', fs.createReadStream(outputFile));
  form.append('num_speakers', '2'); // Default or intelligent guess?
  // form.append('language', 'id'); // Auto-detect is better usually
  
  const response = await axios.post(
    `${config.WHISPERX_API_URL}/transcribe`,
    form,
    {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 1800000, // 30 minutes
    }
  );

  logger.info(`[AudioService] WhisperX transcription completed`);

  return {
    transcription: response.data,
    audioPath: `/uploads/meetings/${meetingId}.webm`,
  };
};
