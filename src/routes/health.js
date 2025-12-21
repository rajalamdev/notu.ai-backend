const express = require('express');
const { checkHealth } = require('../services/whisperxService');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

/**
 * GET /api/health
 * Health check endpoint
 */
router.get('/', asyncHandler(async (req, res) => {
  const whisperxHealth = await checkHealth();
  
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      api: 'healthy',
      whisperx: whisperxHealth.status === 'healthy' ? 'healthy' : 'unhealthy',
    },
  });
}));

module.exports = router;
