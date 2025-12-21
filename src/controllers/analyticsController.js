const mongoose = require('mongoose');
const Meeting = require('../models/Meeting');
const Task = require('../models/Task');
const logger = require('../utils/logger');

/**
 * Get dashboard statistics
 * GET /api/analytics/stats
 */
const getStats = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    
    const [
      totalMeetings,
      completedMeetings,
      pendingMeetings,
      processingMeetings,
      failedMeetings,
      durationAgg,
      taskStats
    ] = await Promise.all([
      Meeting.countDocuments({ userId }),
      Meeting.countDocuments({ userId, status: 'completed' }),
      Meeting.countDocuments({ userId, status: 'pending' }),
      Meeting.countDocuments({ userId, status: 'processing' }),
      Meeting.countDocuments({ userId, status: 'failed' }),
      Meeting.aggregate([
        { $match: { userId, status: 'completed' } },
        { $group: { _id: null, totalDuration: { $sum: '$duration' } } }
      ]),
      Task.aggregate([
        { $match: { userId } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ])
    ]);
    
    const totalMinutes = Math.round((durationAgg[0]?.totalDuration || 0) / 60);
    
    const tasksByStatus = {
      todo: 0,
      'in-progress': 0,
      done: 0,
    };
    taskStats.forEach(s => {
      tasksByStatus[s._id] = s.count;
    });
    
    res.json({
      success: true,
      data: {
        meetings: {
          total: totalMeetings,
          completed: completedMeetings,
          pending: pendingMeetings,
          processing: processingMeetings,
          failed: failedMeetings,
        },
        totalMinutes,
        totalHours: Math.round(totalMinutes / 60 * 10) / 10,
        tasks: tasksByStatus,
        totalTasks: taskStats.reduce((sum, s) => sum + s.count, 0),
      },
    });
  } catch (error) {
    logger.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get statistics',
      error: error.message,
    });
  }
};

/**
 * Get meeting trends over time
 * GET /api/analytics/trends
 */
const getTrends = async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    const userId = new mongoose.Types.ObjectId(req.user.id);
    
    let days;
    switch (period) {
      case '30d': days = 30; break;
      case '90d': days = 90; break;
      case '7d': 
      default: days = 7; break;
    }
    
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const meetingTrends = await Meeting.aggregate([
      { 
        $match: { 
          userId, 
          createdAt: { $gte: startDate } 
        } 
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
          totalDuration: { $sum: '$duration' },
          completed: { 
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } 
          },
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Fill in missing dates with zeros
    const filledTrends = [];
    const dateMap = new Map(meetingTrends.map(t => [t._id, t]));
    
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split('T')[0];
      
      if (dateMap.has(dateStr)) {
        filledTrends.push(dateMap.get(dateStr));
      } else {
        filledTrends.push({
          _id: dateStr,
          count: 0,
          totalDuration: 0,
          completed: 0,
        });
      }
    }
    
    res.json({
      success: true,
      data: filledTrends,
      period,
    });
  } catch (error) {
    logger.error('Get trends error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get trends',
      error: error.message,
    });
  }
};

/**
 * Get platform distribution
 * GET /api/analytics/platforms
 */
const getPlatformStats = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    
    const platformStats = await Meeting.aggregate([
      { $match: { userId } },
      { $group: { _id: '$platform', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    res.json({
      success: true,
      data: platformStats.map(p => ({
        platform: p._id,
        count: p.count,
      })),
    });
  } catch (error) {
    logger.error('Get platform stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get platform statistics',
      error: error.message,
    });
  }
};

/**
 * Get recent activity
 * GET /api/analytics/activity
 */
const getRecentActivity = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const { limit = 10 } = req.query;
    
    const recentMeetings = await Meeting.find({ userId })
      .select('title status platform createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(parseInt(limit));
    
    const recentTasks = await Task.find({ userId })
      .select('title status priority createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(parseInt(limit));
    
    // Combine and sort by date
    const activity = [
      ...recentMeetings.map(m => ({
        type: 'meeting',
        id: m._id,
        title: m.title,
        status: m.status,
        platform: m.platform,
        date: m.updatedAt,
      })),
      ...recentTasks.map(t => ({
        type: 'task',
        id: t._id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        date: t.updatedAt,
      })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date))
     .slice(0, parseInt(limit));
    
    res.json({
      success: true,
      data: activity,
    });
  } catch (error) {
    logger.error('Get recent activity error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get recent activity',
      error: error.message,
    });
  }
};

module.exports = {
  getStats,
  getTrends,
  getPlatformStats,
  getRecentActivity,
};
