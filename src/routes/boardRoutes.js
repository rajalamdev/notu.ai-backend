const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { 
  getBoards, 
  getBoard, 
  createBoard,
  deleteBoard,
  createFromMeeting,
  updateBoard,
  generateShareLink,
  joinBoard,
  revokeShareLink,
  updateCollaboratorRole,
  removeCollaborator
} = require('../controllers/boardController');

router.use(authenticate);

router.get('/', getBoards);
router.post('/', createBoard);
router.post('/from-meeting', createFromMeeting);
router.get('/:id', getBoard);
router.patch('/:id', updateBoard);
router.delete('/:id', deleteBoard);

// Sharing & Collaboration
router.post('/:id/share', generateShareLink);
router.post('/join/:token', joinBoard);
router.delete('/:id/share', revokeShareLink);
router.patch('/:id/collaborators/:userId', updateCollaboratorRole);
router.delete('/:id/collaborators/:userId', removeCollaborator);

module.exports = router;
