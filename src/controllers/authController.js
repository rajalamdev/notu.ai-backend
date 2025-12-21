const User = require('../models/User');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Generate JWT token for user
 */
const generateToken = (user) => {
  return jwt.sign(
    { 
      id: user._id, 
      email: user.email,
      name: user.name,
    },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN || '7d' }
  );
};

/**
 * Handle Google OAuth callback
 * Creates or updates user based on Google profile
 */
const googleCallback = async (req, res) => {
  try {
    const { googleId, email, name, image } = req.body;

    if (!googleId || !email || !name) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: googleId, email, name',
      });
    }

    // Find or create user
    let user = await User.findOne({ googleId });

    if (user) {
      // Update existing user
      user.name = name;
      user.image = image;
      user.lastLoginAt = new Date();
      await user.save();
      
      logger.info(`User logged in: ${email}`);
    } else {
      // Check if email already exists with different Google ID
      const existingEmail = await User.findOne({ email });
      if (existingEmail) {
        return res.status(400).json({
          success: false,
          message: 'Email already registered with different account',
        });
      }

      // Create new user
      user = await User.create({
        googleId,
        email,
        name,
        image,
        lastLoginAt: new Date(),
      });
      
      logger.info(`New user registered: ${email}`);
    }

    // Generate JWT token
    const token = generateToken(user);

    res.json({
      success: true,
      message: 'Authentication successful',
      data: {
        user: user.toPublicJSON(),
        token,
      },
    });
  } catch (error) {
    logger.error('Google auth error:', error);
    res.status(500).json({
      success: false,
      message: 'Authentication failed',
      error: error.message,
    });
  }
};

/**
 * Get current user profile
 */
const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.json({
      success: true,
      data: user.toPublicJSON(),
    });
  } catch (error) {
    logger.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get profile',
      error: error.message,
    });
  }
};

/**
 * Update user profile
 */
const updateProfile = async (req, res) => {
  try {
    const { name, preferences } = req.body;
    
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (name) user.name = name;
    if (preferences) {
      user.preferences = { ...user.preferences, ...preferences };
    }
    
    await user.save();

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: user.toPublicJSON(),
    });
  } catch (error) {
    logger.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile',
      error: error.message,
    });
  }
};

/**
 * Verify token and return user
 */
const verifyToken = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.json({
      success: true,
      data: user.toPublicJSON(),
    });
  } catch (error) {
    logger.error('Verify token error:', error);
    res.status(500).json({
      success: false,
      message: 'Token verification failed',
      error: error.message,
    });
  }
};

/**
 * Logout user (client-side token removal)
 */
const logout = async (req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully',
  });
};

module.exports = {
  googleCallback,
  getProfile,
  updateProfile,
  verifyToken,
  logout,
};
