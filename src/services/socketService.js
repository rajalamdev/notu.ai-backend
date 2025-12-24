const socketIo = require('socket.io');
const logger = require('../utils/logger');

let io;

const initSocket = (server) => {
  io = socketIo(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    logger.info(`New client joined: ${socket.id}`);

    // Join a specific board room
    socket.on('join_board', (boardId) => {
      socket.join(`board_${boardId}`);
      logger.info(`Client ${socket.id} joined board: ${boardId}`);
    });

    // Leave a board room
    socket.on('leave_board', (boardId) => {
      socket.leave(`board_${boardId}`);
      logger.info(`Client ${socket.id} left board: ${boardId}`);
    });

    // Task created
    socket.on('task_created', (data) => {
      const { boardId, task, userName } = data;
      socket.to(`board_${boardId}`).emit('task_created', { task, userName });
    });

    // Task updated
    socket.on('task_updated', (data) => {
      const { boardId, task, userName } = data;
      socket.to(`board_${boardId}`).emit('task_updated', { task, userName });
    });

    // Task deleted
    socket.on('task_deleted', (data) => {
      const { boardId, taskId, userName } = data;
      socket.to(`board_${boardId}`).emit('task_deleted', { taskId, userName });
    });

    // Task moved (DnD)
    socket.on('task_moved', (data) => {
      const { boardId, taskId, fromStatus, toStatus, newOrder, userName } = data;
      socket.to(`board_${boardId}`).emit('task_moved', { 
        taskId, 
        fromStatus, 
        toStatus, 
        newOrder, 
        userName 
      });
    });

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });

  return io;
};

const getIo = () => {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
};

// Helper function to emit events from controllers
const emitToBoard = (boardId, event, data) => {
  if (io) {
    io.to(`board_${boardId}`).emit(event, data);
  }
};

module.exports = {
  initSocket,
  getIo,
  emitToBoard,
};
