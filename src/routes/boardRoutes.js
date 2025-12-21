const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getBoards, getBoard, createBoard, createFromMeeting } = require('../controllers/boardController');

router.use(authenticate);

router.get('/', getBoards);
router.post('/', createBoard);
router.post('/from-meeting', createFromMeeting);
router.get('/:id', getBoard);

module.exports = router;
