const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // Google OAuth data
  googleId: {
    type: String,
    required: true,
    unique: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  image: {
    type: String, // Profile picture URL from Google
  },
  
  // Subscription info
  plan: {
    type: String,
    enum: ['free', 'pro', 'enterprise'],
    default: 'free',
  },
  
  // Usage tracking
  meetingsCount: {
    type: Number,
    default: 0,
  },
  totalTranscriptionMinutes: {
    type: Number,
    default: 0,
  },
  
  // Settings
  preferences: {
    language: { type: String, default: 'id' }, // Default Indonesia
    notificationEmail: { type: Boolean, default: true },
    autoTranscribe: { type: Boolean, default: true },
  },
  

  
  // Account status
  isActive: {
    type: Boolean,
    default: true,
  },
  lastLoginAt: {
    type: Date,
    default: Date.now,
  },
  
}, {
  timestamps: true,
});

// Indexes
userSchema.index({ email: 1 });
userSchema.index({ googleId: 1 });

// Instance methods
userSchema.methods.toPublicJSON = function() {
  return {
    id: this._id,
    email: this.email,
    name: this.name,
    image: this.image,
    plan: this.plan,
    meetingsCount: this.meetingsCount,
    preferences: this.preferences,
    createdAt: this.createdAt,
  };
};

const User = mongoose.model('User', userSchema);

module.exports = User;
