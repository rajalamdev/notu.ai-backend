const socketIo = require('socket.io');
const logger = require('../utils/logger');
const realtimeTranscriptionService = require('./realtimeTranscriptionService');

let io;

// Track online users per room for presence feature
const roomUsers = new Map(); // Map<roomId, Map<socketId, userInfo>>

const initSocket = (server) => {
  io = socketIo(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.on('connection', (socket) => {
    logger.info(`New client joined: ${socket.id}`);

    // Store user info when they authenticate
    socket.on('authenticate', (userData) => {
      socket.userData = userData;
      logger.info(`Client ${socket.id} authenticated as ${userData?.name || 'Unknown'}`);
    });

    // Join a specific board room
    socket.on('join_board', (boardId) => {
      const roomId = `board_${boardId}`;
      socket.join(roomId);
      addUserToRoom(roomId, socket);
      logger.info(`Client ${socket.id} joined board: ${boardId}`);
      
      // Broadcast updated presence to room
      broadcastPresence(roomId);
    });

    // Leave a board room
    socket.on('leave_board', (boardId) => {
      const roomId = `board_${boardId}`;
      socket.leave(roomId);
      removeUserFromRoom(roomId, socket.id);
      logger.info(`Client ${socket.id} left board: ${boardId}`);
      
      // Broadcast updated presence to room
      broadcastPresence(roomId);
    });

    // Join a specific meeting room
    socket.on('join_meeting', (meetingId) => {
      const roomId = `meeting_${meetingId}`;
      socket.join(roomId);
      addUserToRoom(roomId, socket);
      logger.info(`Client ${socket.id} joined meeting: ${meetingId}`);
      
      // Broadcast updated presence to room
      broadcastPresence(roomId);
    });

    // Leave a meeting room
    socket.on('leave_meeting', (meetingId) => {
      const roomId = `meeting_${meetingId}`;
      socket.leave(roomId);
      removeUserFromRoom(roomId, socket.id);
      logger.info(`Client ${socket.id} left meeting: ${meetingId}`);
      
      // Broadcast updated presence to room
      broadcastPresence(roomId);
    });

    // Request current presence for a room
    socket.on('get_presence', (roomId) => {
      const users = getRoomUsers(roomId);
      socket.emit('presence_update', { roomId, users });
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

    // ========== REALTIME TRANSCRIPTION EVENTS ==========
    
    // Start realtime transcription session
    socket.on('start_realtime_transcription', (data) => {
      const { meetingName } = data || {};
      const userId = socket.userData?.id || socket.id;
      
      try {
        const session = realtimeTranscriptionService.createSession(userId, meetingName);
        socket.realtimeSessionId = session.id;
        
        // Join a room for this session
        socket.join(`realtime_${session.id}`);
        
        socket.emit('realtime_session_started', {
          sessionId: session.id,
          startedAt: session.startedAt,
        });
        
        logger.info(`[Realtime] Session started: ${session.id} by ${userId}`);
      } catch (error) {
        logger.error(`[Realtime] Start session error: ${error.message}`);
        socket.emit('realtime_error', { error: error.message });
      }
    });
    
    // Receive audio chunk for transcription
    socket.on('audio_chunk', async (data) => {
      const { sessionId, audioData, chunkIndex } = data;
      
      if (!sessionId) {
        socket.emit('realtime_error', { error: 'No session ID provided' });
        return;
      }
      
      try {
        // Convert base64 to buffer if needed
        const audioBuffer = Buffer.isBuffer(audioData) 
          ? audioData 
          : Buffer.from(audioData, 'base64');
        
        const result = await realtimeTranscriptionService.processAudioChunk(
          sessionId,
          audioBuffer,
          chunkIndex
        );
        
        if (result.success && result.text) {
          // Emit preview transcript back to client
          socket.emit('preview_transcript', {
            sessionId,
            text: result.text,
            chunkIndex,
            processingTime: result.processingTime,
          });
          
          // Also emit accumulated preview
          const preview = realtimeTranscriptionService.getSessionPreview(sessionId);
          if (preview) {
            socket.emit('accumulated_transcript', {
              sessionId,
              text: preview.text,
              chunksProcessed: preview.chunksProcessed,
              duration: preview.duration,
            });
          }
        }
      } catch (error) {
        logger.error(`[Realtime] Audio chunk error: ${error.message}`);
        socket.emit('realtime_error', { 
          error: error.message,
          chunkIndex,
        });
      }
    });
    
    // Stop realtime transcription and get final result
    socket.on('stop_realtime_transcription', async (data) => {
      const { sessionId, audioData, options } = data || {};
      const targetSessionId = sessionId || socket.realtimeSessionId;
      
      if (!targetSessionId) {
        socket.emit('realtime_error', { error: 'No active session' });
        return;
      }
      
      try {
        socket.emit('realtime_processing', {
          sessionId: targetSessionId,
          message: 'Processing final transcription with diarization...',
        });
        
        // Convert base64 to buffer if audio data is provided
        let audioBuffer = null;
        if (audioData) {
          audioBuffer = Buffer.isBuffer(audioData)
            ? audioData
            : Buffer.from(audioData, 'base64');
        }
        
        const result = await realtimeTranscriptionService.finalizeSession(
          targetSessionId,
          audioBuffer,
          options || {}
        );
        
        socket.emit('final_transcript', {
          sessionId: targetSessionId,
          ...result,
        });
        
        // Leave the session room
        socket.leave(`realtime_${targetSessionId}`);
        socket.realtimeSessionId = null;
        
        logger.info(`[Realtime] Session finalized: ${targetSessionId}`);
      } catch (error) {
        logger.error(`[Realtime] Stop session error: ${error.message}`);
        socket.emit('realtime_error', { 
          error: error.message,
          sessionId: targetSessionId,
        });
      }
    });
    
    // Cancel realtime transcription session
    socket.on('cancel_realtime_transcription', (data) => {
      const { sessionId } = data || {};
      const targetSessionId = sessionId || socket.realtimeSessionId;
      
      if (targetSessionId) {
        realtimeTranscriptionService.cancelSession(targetSessionId);
        socket.leave(`realtime_${targetSessionId}`);
        socket.realtimeSessionId = null;
        socket.emit('realtime_cancelled', { sessionId: targetSessionId });
        logger.info(`[Realtime] Session cancelled: ${targetSessionId}`);
      }
    });

    // ========== END REALTIME TRANSCRIPTION EVENTS ==========

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
      
      // Remove from all rooms and broadcast presence updates
      removeUserFromAllRooms(socket.id);
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

// Presence helper functions
function addUserToRoom(roomId, socket) {
  if (!roomUsers.has(roomId)) {
    roomUsers.set(roomId, new Map());
  }
  const userData = socket.userData || { id: socket.id, name: 'Anonymous' };
  roomUsers.get(roomId).set(socket.id, {
    id: userData.id || socket.id,
    name: userData.name || 'Anonymous',
    image: userData.image || null,
    socketId: socket.id,
    joinedAt: new Date(),
  });
}

function removeUserFromRoom(roomId, socketId) {
  if (roomUsers.has(roomId)) {
    roomUsers.get(roomId).delete(socketId);
    if (roomUsers.get(roomId).size === 0) {
      roomUsers.delete(roomId);
    }
  }
}

function removeUserFromAllRooms(socketId) {
  for (const [roomId, users] of roomUsers.entries()) {
    if (users.has(socketId)) {
      users.delete(socketId);
      if (users.size === 0) {
        roomUsers.delete(roomId);
      } else {
        // Broadcast presence update to remaining users
        broadcastPresence(roomId);
      }
    }
  }
}

function getRoomUsers(roomId) {
  if (!roomUsers.has(roomId)) return [];
  return Array.from(roomUsers.get(roomId).values());
}

function broadcastPresence(roomId) {
  if (io) {
    const users = getRoomUsers(roomId);
    io.to(roomId).emit('presence_update', { roomId, users });
  }
}

// Helper function to emit events from controllers
const emitToBoard = (boardId, event, data) => {
  if (io) {
    io.to(`board_${boardId}`).emit(event, data);
  }
};

// Helper to emit meeting-scoped events
// NOTE: transcription_progress is broadcast globally so status-meeting page doesn't need room joins
const emitToMeeting = (meetingId, event, data) => {
  if (io) {
    if (event === 'transcription_progress' || event === 'worker_heartbeat') {
      // Broadcast globally for progress events - status page monitors multiple meetings
      io.emit(event, { ...data, meetingId });
    } else {
      // Other events stay room-scoped
      io.to(`meeting_${meetingId}`).emit(event, data);
    }
  }
};

// Emit collaborator joined event
const emitCollaboratorJoined = (resourceType, resourceId, userData, role) => {
  if (io) {
    const roomId = `${resourceType}_${resourceId}`;
    io.to(roomId).emit('collaborator_joined', {
      resourceId,
      resourceType,
      user: userData,
      role,
    });
  }
};

// Emit collaborator removed event
const emitCollaboratorRemoved = (resourceType, resourceId, userId) => {
  if (io) {
    const roomId = `${resourceType}_${resourceId}`;
    io.to(roomId).emit('collaborator_removed', {
      resourceId,
      resourceType,
      userId,
    });
  }
};

// Emit collaborator role changed event
const emitCollaboratorRoleChanged = (resourceType, resourceId, userId, newRole) => {
  if (io) {
    const roomId = `${resourceType}_${resourceId}`;
    io.to(roomId).emit('collaborator_role_changed', {
      resourceId,
      resourceType,
      userId,
      newRole,
    });
  }
};

// Meeting content update events (for realtime collaboration)
const emitMeetingContentUpdated = (meetingId, updateType, data, userName) => {
  if (io) {
    const roomId = `meeting_${meetingId}`;
    io.to(roomId).emit('meeting_content_updated', {
      meetingId,
      updateType, // 'segment_edited', 'summary_updated', 'highlights_updated', 'conclusion_updated', 'title_updated', 'description_updated'
      data,
      userName,
      timestamp: new Date(),
    });
  }
};

// Meeting action item events
const emitMeetingActionItemSynced = (meetingId, boardId, userName) => {
  if (io) {
    const roomId = `meeting_${meetingId}`;
    io.to(roomId).emit('meeting_action_synced', {
      meetingId,
      boardId,
      userName,
      timestamp: new Date(),
    });
  }
};

// AI regeneration event
const emitMeetingAiRegenerated = (meetingId, userName) => {
  if (io) {
    const roomId = `meeting_${meetingId}`;
    io.to(roomId).emit('meeting_ai_regenerated', {
      meetingId,
      userName,
      timestamp: new Date(),
    });
  }
};

module.exports = {
  initSocket,
  getIo,
  emitToBoard,
  emitToMeeting,
  emitCollaboratorJoined,
  emitCollaboratorRemoved,
  emitCollaboratorRoleChanged,
  emitMeetingContentUpdated,
  emitMeetingActionItemSynced,
  emitMeetingAiRegenerated,
  getRoomUsers,
};
