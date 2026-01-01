const mongoose = require('mongoose');

/**
 * ChatMessage Model
 * Stores AI chat history for meetings - allows users to ask questions about meeting context
 */
const chatMessageSchema = new mongoose.Schema({
  // Reference to the meeting this chat belongs to
  meetingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Meeting',
    required: true,
    index: true,
  },
  
  // User who sent the message (null for AI responses)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    index: true,
  },
  
  // Message role: 'user' for human, 'assistant' for AI
  role: {
    type: String,
    enum: ['user', 'assistant', 'system'],
    required: true,
  },
  
  // Message content
  content: {
    type: String,
    required: true,
  },
  
  // Optional metadata
  metadata: {
    // Model used for AI response
    model: String,
    // Tokens used
    promptTokens: Number,
    completionTokens: Number,
    // Response time in ms
    responseTime: Number,
    // Error if any
    error: String,
  },
  
}, {
  timestamps: true,
});

// Compound index for efficient queries
chatMessageSchema.index({ meetingId: 1, createdAt: 1 });

// Instance method to format for frontend
chatMessageSchema.methods.toJSON = function() {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  return obj;
};

// Static method to get chat history for a meeting
chatMessageSchema.statics.getChatHistory = async function(meetingId, limit = 50) {
  return this.find({ meetingId })
    .sort({ createdAt: 1 })
    .limit(limit)
    .populate('userId', 'name email image')
    .lean();
};

// Static method to add a message
chatMessageSchema.statics.addMessage = async function(meetingId, userId, role, content, metadata = {}) {
  return this.create({
    meetingId,
    userId: role === 'user' ? userId : null,
    role,
    content,
    metadata,
  });
};

// Static method to clear chat history for a meeting
chatMessageSchema.statics.clearHistory = async function(meetingId) {
  return this.deleteMany({ meetingId });
};

const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

module.exports = ChatMessage;
