const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  meetingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Meeting',
  },
  boardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Board',
  },
  // Source of the task
  source: {
    type: String,
    enum: ['ai', 'manual'],
    default: 'manual',
  },
  title: {
    type: String,
    required: true,
    yotrim: true,
  },
  description: {
    type: String,
    trim: true,
  },
  status: {
    type: String,
    enum: ['todo', 'in_progress', 'done'],
    default: 'todo',
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
  },
  dueDate: {
    type: Date,
  },
  // Reference to User for assignment (enables collaboration)
  assignee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  // Assignee name from AI extraction (before user assignment)
  assigneeName: {
    type: String,
    trim: true,
  },
  // Labels/tags for categorization
  labels: [{
    type: String,
    trim: true,
  }],
  order: {
    type: Number,
    default: 0,
  },
  completedAt: {
    type: Date,
  },
}, {
  timestamps: true,
});

// Indexes
taskSchema.index({ userId: 1, status: 1 });
taskSchema.index({ userId: 1, meetingId: 1 });
taskSchema.index({ userId: 1, order: 1 });
taskSchema.index({ meetingId: 1, source: 1 });

// Virtual for formatted due date
taskSchema.virtual('isOverdue').get(function() {
  if (!this.dueDate) return false;
  return new Date() > this.dueDate && this.status !== 'done';
});

// Transform to JSON
taskSchema.set('toJSON', { virtuals: true });

const Task = mongoose.model('Task', taskSchema);

module.exports = Task;
