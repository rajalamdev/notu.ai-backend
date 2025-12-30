/**
 * Shared Mongoose schemas used across multiple models
 * This reduces duplication and ensures consistency
 */

const mongoose = require('mongoose');
const { COLLABORATOR_ROLES } = require('./constants');

/**
 * Collaborator schema - used in Board, Meeting, and any other collaborative entities
 * Represents a user who has access to a resource with a specific role
 */
const collaboratorSchema = new mongoose.Schema({
  user: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: true 
  },
  role: { 
    type: String, 
    enum: Object.values(COLLABORATOR_ROLES), 
    default: COLLABORATOR_ROLES.VIEWER 
  },
  joinedAt: { 
    type: Date, 
    default: Date.now 
  }
}, { _id: false });

/**
 * Label schema - used for tagging/categorizing items (tasks, etc)
 */
const labelSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true,
    trim: true 
  },
  color: { 
    type: String, 
    default: '#4f46e5' 
  }
});

module.exports = {
  collaboratorSchema,
  labelSchema,
};
