const mongoose = require('mongoose');
const { MEETING_STATUS, MEETING_TYPE, PLATFORM } = require('../utils/constants');

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
  
  // Transcription data
  transcription: transcriptionSchema,
  
  // Note: Action items are now stored in Task collection with meetingId reference
  // Use Task.find({ meetingId: meeting._id }) to get action items
  
  // Sharing & collaboration
  isPublic: { type: Boolean, default: false },
  shareToken: { type: String, unique: true, sparse: true },
  collaborators: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: { 
      type: String, 
      enum: ['owner', 'editor', 'viewer'], 
      default: 'viewer' 
    },
    joinedAt: { type: Date, default: Date.now }
  }],
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
  },
  // Short summary/snippet used in list views to avoid loading full transcript
  summarySnippet: { type: String, default: '' },
  // Soft-delete flag
  deleted: { type: Boolean, default: false },
  
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
