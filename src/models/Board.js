const mongoose = require('mongoose');
const { collaboratorSchema, labelSchema } = require('../utils/schemas');

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
  collaborators: [collaboratorSchema],
  labels: [labelSchema],
  // Pinned to sidebar - per-user (max 3 per user enforced in controller)
  pinnedBy: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    pinnedAt: { type: Date, default: Date.now },
  }],
}, {
  timestamps: true,
});

const Board = mongoose.models.Board || mongoose.model('Board', boardSchema);

module.exports = Board;
