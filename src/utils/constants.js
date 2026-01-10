module.exports = {
  // File types
  ALLOWED_MIME_TYPES: [
    'audio/mpeg',        // .mp3
    'audio/mp4',         // .m4a
    'audio/wav',         // .wav
    'video/mp4',         // .mp4
    'audio/x-m4a',       // .m4a alternative
  ],

  ALLOWED_EXTENSIONS: ['.mp3', '.mp4', '.wav', '.m4a'],

  // Meeting status
  MEETING_STATUS: {
    PENDING: 'pending',
    QUEUED: 'queued',
    BOT_JOINING: 'bot_joining',  // Bot is connecting to meeting
    RECORDING: 'recording',      // Bot is recording/transcribing live
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
  },

  // Progress weights for stage-based progress (UPLOAD workflow)
  // Ranges are NON-OVERLAPPING: each stage ends just before next starts
  PROGRESS_WEIGHTS: {
    starting: { start: 0, end: 9 },
    downloading: { start: 10, end: 19 },
    transcribing: { start: 20, end: 69 },
    diarization: { start: 70, end: 79 },
    ai_analysis: { start: 80, end: 89 },
    saving: { start: 90, end: 99 },
    completed: { start: 100, end: 100 },
  },

  // Progress weights for BOT/ONLINE MEETING workflow - 4 stages
  BOT_PROGRESS_WEIGHTS: {
    bot_connecting: { start: 0, end: 19 },
    bot_joining: { start: 20, end: 39 },
    bot_recording: { start: 40, end: 99 },  // Combined recording + transcription
    completed: { start: 100, end: 100 },
  },

  // Meeting types
  MEETING_TYPE: {
    UPLOAD: 'upload',
    ONLINE: 'online',
    REALTIME: 'realtime',
  },

  // Platform types
  PLATFORM: {
    GOOGLE_MEET: 'Google Meet',
    UPLOAD: 'Upload',
    ZOOM: 'Zoom',
    TEAMS: 'Microsoft Teams',
    MICROPHONE: 'Microphone',
    OTHER: 'Other',
  },

  // Job queue names
  QUEUE_NAMES: {
    TRANSCRIPTION: 'transcription-queue',
  },

  // Job priorities
  JOB_PRIORITY: {
    HIGH: 1,
    NORMAL: 5,
    LOW: 10,
  },

  // Retry settings
  MAX_RETRIES: 3,
  RETRY_DELAY: 5000, // 5 seconds

  // WhisperX settings
  WHISPERX_DEFAULTS: {
    NUM_SPEAKERS: 0, // Auto-detect
    DIARIZATION_METHOD: 'multi',
    ENABLE_SUMMARY: true,
  },
  // Collaborator roles
  COLLABORATOR_ROLES: {
    OWNER: 'owner',
    ADMIN: 'admin',
    EDITOR: 'editor',
    VIEWER: 'viewer',
  },

  // Task status (consistent with Task model enum)
  TASK_STATUS: {
    TODO: 'todo',
    IN_PROGRESS: 'in-progress',
    REVIEW: 'review',
    DONE: 'done',
  },

  // Task priority
  TASK_PRIORITY: {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    URGENT: 'urgent',
  },

  // Pagination defaults
  PAGINATION: {
    DEFAULT_PAGE: 1,
    DEFAULT_LIMIT: 10,
    MAX_LIMIT: 100,
  },
};
