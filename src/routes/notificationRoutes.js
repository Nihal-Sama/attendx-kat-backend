const express    = require('express');
const router     = express.Router();
const auth       = require('../middleware/auth');
const controller = require('../controllers/notificationController');

router.get  ('/',           auth, controller.getNotifications);
router.patch('/read-all',   auth, controller.markAllRead);
router.patch('/:id/read',   auth, controller.markOneRead);

module.exports = router;
