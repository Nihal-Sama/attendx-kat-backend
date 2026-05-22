const express    = require('express');
const router     = express.Router();
const auth       = require('../middleware/auth');
const controller = require('../controllers/authController');

// ── Public routes (no JWT required) ──────────────────────────
router.post('/login',           controller.login);
router.post('/forgot-password', controller.forgotPassword);  // ← new
router.post('/confirm-reset',   controller.confirmReset);    // ← new

// ── Protected routes (JWT required) ──────────────────────────
router.post ('/logout',          auth, controller.logout);
router.get ('/me',               auth, controller.me);
router.patch('/reset-password',  auth, controller.resetPassword);

module.exports = router;
