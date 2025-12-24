const mongoose = require('mongoose');

const boardSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  meetingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Meeting',
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    trim: true,
  },
  source: {
    type: String,
    enum: ['manual', 'ai'],
    default: 'manual',
  },
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
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  labels: [{
    name: { type: String, required: true },
    color: { type: String, default: '#4f46e5' }
  }]
});

// Update timestamp on save
boardSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const Board = mongoose.models.Board || mongoose.model('Board', boardSchema);

module.exports = Board;
