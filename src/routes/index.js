const express = require('express');
const uploadRoutes = require('./upload');
const meetingRoutes = require('./meetings');
const healthRoutes = require('./health');
const authRoutes = require('./auth');
const taskRoutes = require('./tasks');
const boardRoutes = require('./boardRoutes');
const analyticsRoutes = require('./analytics');
const botRoutes = require('./botRoutes');

const router = express.Router();

// Mount routes
router.use('/auth', authRoutes);
router.use('/upload', uploadRoutes);
router.use('/meetings', meetingRoutes);
router.use('/health', healthRoutes);
router.use('/tasks', taskRoutes);
router.use('/boards', boardRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/bot', botRoutes);

module.exports = router;

