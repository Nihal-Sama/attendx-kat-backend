const express     = require('express');
const router      = express.Router();
const auth        = require('../middleware/auth');
const controller  = require('../controllers/chatController');

router.get   ('/messages',      auth, controller.getMessages);
router.post  ('/messages',      auth, controller.sendMessage);
router.delete('/messages/:id',  auth, controller.deleteMessage);

module.exports = router;
