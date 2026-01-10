const mongoose = require('mongoose');
const Meeting = require('../models/Meeting');
const Task = require('../models/Task');
const Board = require('../models/Board');
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

/**
 * Get global analytics - comprehensive overview
 * GET /api/analytics/global
 */
const getGlobalAnalytics = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    
    // Run all queries in parallel
    const [
      meetingStats,
      typeDist,
      taskAgg,
      boardCount,
      durationStats,
      speakerStats,
      topicStats,
      participantStats,
      trends30d
    ] = await Promise.all([
      // Meeting statistics
      Meeting.aggregate([
        { $match: { userId } },
        { $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalDuration: { $sum: '$duration' }
          }
        }
      ]),
      
      // Type distribution (online, realtime, upload)
      Meeting.aggregate([
        { $match: { userId } },
        { $group: { _id: '$type', count: { $sum: 1 } } }
      ]),
      
      // Task aggregation
      Task.aggregate([
        { $match: { userId } },
        { $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]),
      
      // Board count
      Board.countDocuments({ userId }),
      
      // Duration statistics
      Meeting.aggregate([
        { $match: { userId, status: 'completed' } },
        { $group: {
            _id: null,
            avgDuration: { $avg: '$duration' },
            totalDuration: { $sum: '$duration' },
            minDuration: { $min: '$duration' },
            maxDuration: { $max: '$duration' }
          }
        }
      ]),
      
      // Top speakers (aggregated from all meetings' segments)
      Meeting.aggregate([
        { $match: { userId, status: 'completed' } },
        { $unwind: { path: '$transcription.segments', preserveNullAndEmptyArrays: false } },
        { $addFields: {
            segmentDuration: { $subtract: ['$transcription.segments.end', '$transcription.segments.start'] },
            segmentWords: { 
              $size: { 
                $split: [{ $ifNull: ['$transcription.segments.text', ''] }, ' '] 
              } 
            }
          }
        },
        { $group: {
            _id: '$transcription.segments.speaker',
            totalTime: { $sum: '$segmentDuration' },
            totalWords: { $sum: '$segmentWords' },
            meetingCount: { $addToSet: '$_id' }
          }
        },
        { $addFields: { meetingCount: { $size: '$meetingCount' } } },
        { $sort: { totalWords: -1 } },
        { $limit: 10 }
      ]),
      
      // Top topics/keywords (from highlights object keys)
      Meeting.aggregate([
        { $match: { userId, status: 'completed', 'transcription.highlights': { $exists: true, $ne: null } } },
        { $project: { highlightKeys: { $objectToArray: '$transcription.highlights' } } },
        { $unwind: '$highlightKeys' },
        { $group: {
            _id: '$highlightKeys.k',
            frequency: { $sum: 1 }
          }
        },
        { $sort: { frequency: -1 } },
        { $limit: 20 }
      ]),
      
      // Participant statistics
      Meeting.aggregate([
        { $match: { userId, status: 'completed' } },
        { $project: {
            participantCount: {
              $cond: {
                if: { $isArray: '$participants' },
                then: { $size: '$participants' },
                else: 0
              }
            }
          }
        },
        { $group: {
            _id: null,
            avgParticipants: { $avg: '$participantCount' },
            totalUniqueParticipants: { $sum: '$participantCount' }
          }
        }
      ]),
      
      // 30-day trend
      Meeting.aggregate([
        { $match: {
            userId,
            createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
          }
        },
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
            duration: { $sum: '$duration' }
          }
        },
        { $sort: { _id: 1 } }
      ])
    ]);
    
    // Process meeting stats
    const meetings = {
      total: 0,
      completed: 0,
      processing: 0,
      failed: 0,
      pending: 0
    };
    let totalDuration = 0;
    meetingStats.forEach(s => {
      meetings[s._id] = s.count;
      meetings.total += s.count;
      totalDuration += s.totalDuration || 0;
    });
    
    // Process type distribution
    const totalMeetings = meetings.total || 1; // Prevent division by zero
    const meetingsByType = typeDist.map(t => ({
      type: t._id || 'unknown',
      count: t.count,
      percentage: Math.round((t.count / totalMeetings) * 100)
    }));
    
    // Process task stats
    const tasks = { todo: 0, 'in-progress': 0, done: 0, total: 0 };
    taskAgg.forEach(t => {
      tasks[t._id] = t.count;
      tasks.total += t.count;
    });
    
    // Calculate completion rate
    const completionRate = meetings.total > 0 
      ? Math.round((meetings.completed / meetings.total) * 100)
      : 0;
    
    res.json({
      success: true,
      data: {
        meetings,
        meetingsByType,
        totalDuration: Math.round(totalDuration / 60), // convert to minutes
        avgDuration: durationStats[0]?.avgDuration 
          ? Math.round(durationStats[0].avgDuration / 60) 
          : 0,
        tasks,
        boards: { total: boardCount },
        completionRate,
        participants: {
          avg: participantStats[0]?.avgParticipants || 0,
          total: participantStats[0]?.totalUniqueParticipants || 0
        },
        topSpeakers: speakerStats.map(s => ({
          name: s._id,
          totalTime: s.totalTime,
          totalWords: s.totalWords,
          meetingCount: s.meetingCount
        })),
        topTopics: topicStats.map(t => ({
          keyword: t._id,
          frequency: t.frequency
        })),
        trends: trends30d
      }
    });
  } catch (error) {
    logger.error('Get global analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get global analytics',
      error: error.message
    });
  }
};

/**
 * Get detail analytics - meeting list with preview metrics
 * GET /api/analytics/meetings
 */
const getDetailAnalyticsList = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const { 
      page = 1, 
      limit = 10, 
      sortBy = 'date', 
      filter = 'all',
      search = ''
    } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build match query
    const matchQuery = { userId };
    if (filter !== 'all') {
      matchQuery.type = filter; // Filter by type: online, realtime, upload
    }
    // Add search if provided
    if (search && search.trim()) {
      matchQuery.title = { $regex: search.trim(), $options: 'i' };
    }
    
    // Build sort query
    let sortQuery = {};
    switch (sortBy) {
      case 'duration':
        sortQuery = { duration: -1 };
        break;
      case 'participants':
        sortQuery = { participantsCount: -1 };
        break;
      case 'actions':
        sortQuery = { actionItemsCount: -1 };
        break;
      case 'date':
      default:
        sortQuery = { createdAt: -1 };
        break;
    }
    
    const [meetings, totalCount] = await Promise.all([
      Meeting.aggregate([
        { $match: matchQuery },
        { $addFields: {
            participantsCount: {
              $cond: {
                if: { $gt: ['$participants', 0] },
                then: '$participants',
                else: 0
              }
            },
            speakersCount: {
              $size: {
                $setUnion: {
                  $map: {
                    input: { $ifNull: ['$transcription.segments', []] },
                    as: 'seg',
                    in: '$$seg.speaker'
                  }
                }
              }
            },
            topicsCount: {
              $cond: {
                if: { $and: [
                  { $ne: ['$transcription.highlights', null] },
                  { $eq: [{ $type: '$transcription.highlights' }, 'object'] }
                ]},
                then: { $size: { $objectToArray: { $ifNull: ['$transcription.highlights', {}] } } },
                else: 0
              }
            },
            actionItemsCount: {
              $cond: {
                if: { $isArray: '$actionItems' },
                then: { $size: '$actionItems' },
                else: 0
              }
            }
          }
        },
        { $sort: sortQuery },
        { $skip: skip },
        { $limit: parseInt(limit) },
        { $project: {
            title: 1,
            createdAt: 1,
            duration: 1,
            type: 1,
            status: 1,
            participantsCount: 1,
            speakersCount: 1,
            topicsCount: 1,
            actionItemsCount: 1,
            hasBoard: { $toBool: '$boardId' }
          }
        }
      ]),
      Meeting.countDocuments(matchQuery)
    ]);
    
    res.json({
      success: true,
      data: {
        meetings,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(totalCount / parseInt(limit)),
          totalItems: totalCount
        }
      }
    });
  } catch (error) {
    logger.error('Get detail analytics list error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get detail analytics',
      error: error.message
    });
  }
};

/**
 * Get meeting detail analytics
 * GET /api/analytics/meetings/:id/detail
 */
const getMeetingDetailAnalytics = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const meetingId = req.params.id;
    
    // Get the meeting with full transcription data
    const meeting = await Meeting.findOne({ 
      _id: meetingId, 
      userId 
    }).select('title description createdAt duration type status platform participants transcription actionItems boardId');
    
    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: 'Meeting not found'
      });
    }
    
    // Calculate speaker stats from transcription.segments
    const segments = meeting.transcription?.segments || [];
    const speakerMap = {};
    let totalDurationSec = 0;
    let totalWords = 0;
    
    segments.forEach(seg => {
      const speaker = seg.speaker || 'Unknown';
      const duration = (seg.end || 0) - (seg.start || 0);
      const words = seg.text ? seg.text.split(/\s+/).filter(w => w.length > 0).length : 0;
      
      if (!speakerMap[speaker]) {
        speakerMap[speaker] = { speaker, time: 0, words: 0, talks: 0 };
      }
      speakerMap[speaker].time += duration;
      speakerMap[speaker].words += words;
      speakerMap[speaker].talks += 1;
      totalDurationSec += duration;
      totalWords += words;
    });
    
    // Convert to array with percentages
    const speakers = Object.values(speakerMap).map(s => ({
      speaker: s.speaker,
      total: totalDurationSec > 0 ? Math.round((s.time / totalDurationSec) * 100) : 0,
      words: s.words,
      talks: s.talks
    })).sort((a, b) => b.total - a.total);
    
    // Extract topics from highlights keys
    let topics = [];
    if (meeting.transcription?.highlights && typeof meeting.transcription.highlights === 'object') {
      topics = Object.keys(meeting.transcription.highlights).map(key => ({
        name: key,
        color: null
      }));
    }
    
    // Calculate user's average metrics for comparison
    const avgMetrics = await Meeting.aggregate([
      { $match: { userId, status: 'completed' } },
      { $addFields: {
          actionItemsCount: {
            $cond: {
              if: { $isArray: '$actionItems' },
              then: { $size: '$actionItems' },
              else: 0
            }
          }
        }
      },
      { $group: {
          _id: null,
          avgDuration: { $avg: '$duration' },
          avgParticipants: { $avg: { $ifNull: ['$participants', 0] } },
          avgActionItems: { $avg: '$actionItemsCount' }
        }
      }
    ]);
    
    const avg = avgMetrics[0] || { avgDuration: 0, avgParticipants: 0, avgActionItems: 0 };
    
    // Current meeting values
    const currentDuration = meeting.duration || 0;
    const currentParticipants = typeof meeting.participants === 'number' ? meeting.participants : speakers.length;
    const currentActionItems = meeting.actionItems?.length || 0;
    
    const comparison = {
      avgDuration: Math.round((avg.avgDuration || 0) / 60),
      avgParticipants: Math.round((avg.avgParticipants || 0) * 10) / 10,
      avgActionItems: Math.round((avg.avgActionItems || 0) * 10) / 10,
      vsAverage: {
        duration: avg.avgDuration > 0 
          ? Math.round(((currentDuration - avg.avgDuration) / avg.avgDuration) * 100)
          : 0,
        participants: avg.avgParticipants > 0
          ? Math.round(((currentParticipants - avg.avgParticipants) / avg.avgParticipants) * 100)
          : 0,
        actionItems: avg.avgActionItems > 0
          ? Math.round(((currentActionItems - avg.avgActionItems) / avg.avgActionItems) * 100)
          : 0
      }
    };
    
    res.json({
      success: true,
      data: {
        meeting: {
          _id: meeting._id,
          title: meeting.title,
          description: meeting.description,
          createdAt: meeting.createdAt,
          duration: meeting.duration,
          type: meeting.type,
          status: meeting.status,
          platform: meeting.platform,
          hasBoard: !!meeting.boardId
        },
        speakers,
        topics,
        actionItems: meeting.actionItems || [],
        participants: currentParticipants,
        totalWords,
        comparison
      }
    });
  } catch (error) {
    logger.error('Get meeting detail analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get meeting detail analytics',
      error: error.message
    });
  }
};

module.exports = {
  getStats,
  getTrends,
  getPlatformStats,
  getRecentActivity,
  getGlobalAnalytics,
  getDetailAnalyticsList,
  getMeetingDetailAnalytics
};
