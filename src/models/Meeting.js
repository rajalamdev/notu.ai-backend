const mongoose = require('mongoose');
const { MEETING_STATUS, MEETING_TYPE, PLATFORM } = require('../utils/constants');
const { collaboratorSchema } = require('../utils/schemas');

const segmentSchema = new mongoose.Schema({
  start: { type: Number, required: true },
  end: { type: Number, required: true },
  text: { type: String, required: true },
  speaker: { type: String, required: true },
}, { _id: false });

const speakerSchema = new mongoose.Schema({
  speaker: { type: String, required: true },
  start: { type: Number, required: true },
  end: { type: Number, required: true },
}, { _id: false });

const transcriptionSchema = new mongoose.Schema({
  language: String,
  transcript: String,
  segments: [segmentSchema],
  speakers: [speakerSchema],
  summary: String,
  highlights: mongoose.Schema.Types.Mixed, // Dynamic object with sub-headers as keys, markdown content as values
  conclusion: String, // Meeting conclusion
  diarizationMethod: String,
  numSpeakers: Number,
  processingTime: Number, // in seconds
}, { _id: false });

const originalFileSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  originalName: String,
  mimetype: String,
  size: Number,
  path: String, // MinIO path
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });



const meetingSchema = new mongoose.Schema({
  // User & basic info
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // For future auth
  title: { type: String, required: true },
  description: String,
  
  // Platform & type
  platform: {
    type: String,
    enum: Object.values(PLATFORM),
    default: PLATFORM.UPLOAD,
  },
  type: {
    type: String,
    enum: Object.values(MEETING_TYPE),
    required: true,
  },
  status: {
    type: String,
    enum: Object.values(MEETING_STATUS),
    default: MEETING_STATUS.PENDING,
    required: true,
  },
  
  // Meeting metadata
  meetingLink: String, // For online meetings
  scheduledAt: Date,
  startedAt: Date,
  endedAt: Date,
  duration: Number, // in seconds
  participants: { type: Number, default: 0 },
  
  // File information
  originalFile: originalFileSchema,
  audioUrl: String, // Direct URL to audio file

  
  // Transcription data
  transcription: transcriptionSchema,
  
  // AI Generated Candidates (Human-in-the-loop workflow)
  // These are not yet real Tasks. User must approve them.
  actionItems: [{
    title: String,
    description: String,
    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    dueDate: Date,
    dueDateRaw: String,
    assigneeName: String,
    labels: [String],
    status: { type: String, default: 'todo' } 
  }],

  suggestedTitle: String,

  
  // Sharing & collaboration
  isPublic: { type: Boolean, default: false },
  shareToken: { type: String, unique: true, sparse: true },
  collaborators: [collaboratorSchema],
  tags: [String],
  
  // Error tracking
  errorMessage: String,
  retryCount: { type: Number, default: 0 },
  // Lightweight processing metadata for job tracing and polling
  processingMeta: {
    jobId: String,
    queuedAt: Date,
    processingStartedAt: Date,
    lastUpdatedAt: Date,
    lastHeartbeat: Date,  // For detecting hung workers
    currentStage: String, // Current processing stage
    chunkInfo: {          // For chunked transcription
      currentChunk: Number,
      totalChunks: Number,
      chunkingEnabled: Boolean,
    },
  },
  processingLogs: [{
    message: String,
    timestamp: { type: Date, default: Date.now },
    progress: Number,
    stage: String
  }],
  // Short summary/snippet used in list views to avoid loading full transcript
  summarySnippet: { type: String, default: '' },
  // Soft-delete flag
  deleted: { type: Boolean, default: false },
  
  // Pinned to sidebar - per-user (max 3 per user enforced in controller)
  pinnedBy: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    pinnedAt: { type: Date, default: Date.now },
  }],
  
}, {
  timestamps: true, // Adds createdAt and updatedAt
});

// Indexes for better query performance
meetingSchema.index({ userId: 1, createdAt: -1 });
meetingSchema.index({ status: 1 });
meetingSchema.index({ type: 1 });
meetingSchema.index({ 'originalFile.filename': 1 });
// Index collaborators.user for efficient shared queries
meetingSchema.index({ 'collaborators.user': 1 });
// Text index for searching title and description
meetingSchema.index({ title: 'text', description: 'text' });

// Virtual for meeting URL
meetingSchema.virtual('url').get(function() {
  return `/api/meetings/${this._id}`;
});

// Method to calculate duration from timestamps
meetingSchema.methods.calculateDuration = function() {
  if (this.startedAt && this.endedAt) {
    this.duration = Math.floor((this.endedAt - this.startedAt) / 1000);
  }
  return this.duration;
};

// Method to update status
meetingSchema.methods.updateStatus = async function(status, errorMessage = null) {
  this.status = status;
  if (errorMessage) {
    this.errorMessage = errorMessage;
  }
  return await this.save();
};

// Method to increment retry count
meetingSchema.methods.incrementRetry = async function() {
  this.retryCount += 1;
  return await this.save();
};

const Meeting = mongoose.model('Meeting', meetingSchema);

module.exports = Meeting;
