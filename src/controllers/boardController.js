const Board = require('../models/Board');
const Task = require('../models/Task');
const Meeting = require('../models/Meeting');

exports.getBoards = async (req, res) => {
  try {
    const boards = await Board.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json({ success: true, count: boards.length, data: boards });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.getBoard = async (req, res) => {
  try {
    const board = await Board.findOne({ _id: req.params.id, userId: req.user.id });
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found' });
    }
    // Also fetch tasks logic if needed? Usually tasks API fetches tasks by boardId
    // But for convenience, we can return board details here.
    res.json({ success: true, data: board });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.createBoard = async (req, res) => {
  try {
    const { title, description } = req.body;
    const board = await Board.create({
      userId: req.user.id,
      title,
      description
    });
    res.status(201).json({ success: true, data: board });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

exports.createFromMeeting = async (req, res) => {
  try {
    const { meetingId } = req.body;
    if (!meetingId) {
      return res.status(400).json({ success: false, message: 'Meeting ID required' });
    }

    const meeting = await Meeting.findOne({ _id: meetingId, userId: req.user.id });
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    // Check if board already exists for this meeting
    let board = await Board.findOne({ meetingId: meeting._id, userId: req.user.id });
    
    if (!board) {
      // Create Board
      board = await Board.create({
        userId: req.user.id,
        meetingId: meeting._id,
        title: meeting.title || 'Untitled Meeting Kanban',
        description: `Generated from meeting on ${new Date(meeting.createdAt).toLocaleDateString()}`
      });
    }

    // Update Tasks
    const updated = await Task.updateMany(
      { meetingId: meeting._id, userId: req.user.id },
      { $set: { boardId: board._id } }
    );

    res.status(201).json({ 
      success: true, 
      data: board,
      tasksMigrated: updated.modifiedCount 
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};
