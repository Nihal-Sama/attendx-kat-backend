const express    = require('express');
const router     = express.Router();
const auth       = require('../middleware/auth');
const controller = require('../controllers/authController');

router.post('/login',          controller.login);
router.post('/logout',   auth,  controller.logout);
router.get ('/me',       auth,  controller.me);
router.patch('/reset-password', auth, controller.resetPassword);

module.exports = router;
