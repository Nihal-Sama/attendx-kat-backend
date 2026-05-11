// ============================================================
//  screenshotRoutes.js
// ============================================================
const express     = require('express');
const router      = express.Router();
const auth        = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const controller  = require('../controllers/screenshotController');

// Summary must come before /:id style routes to avoid conflicts
router.get(
  '/summary',
  auth,
  requireRole('admin', 'ceo'),
  controller.getScreenshotSummary
);

// Admin/CEO fetches screenshots for a specific employee + date
router.get(
  '/',
  auth,
  requireRole('admin', 'ceo'),
  controller.getScreenshots
);

// Employee saves a screenshot URL after uploading to ImageKit
router.post(
  '/',
  auth,
  requireRole('employee'),
  controller.saveScreenshot
);

module.exports = router;