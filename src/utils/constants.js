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
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
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
    EDITOR: 'editor',
    VIEWER: 'viewer',
  },
};
