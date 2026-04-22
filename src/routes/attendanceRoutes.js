const express     = require('express');
const router      = express.Router();
const multer      = require('multer');
const auth        = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const controller  = require('../controllers/attendanceController');

// Store file in memory buffer so we can forward it to ImageKit
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
});

router.post('/checkin',       auth, requireRole('employee'),         upload.single('photo'), controller.checkIn);
router.post('/checkout',      auth, requireRole('employee'),         upload.single('photo'), controller.checkOut);
router.post('/break/start',   auth, requireRole('employee'),         controller.startBreak);
router.post('/break/end',     auth, requireRole('employee'),         controller.endBreak);
router.get ('/today',         auth,                                  controller.getToday);
router.get ('/summary',       auth,                                  controller.getMonthlySummary);
router.get ('/history',       auth, requireRole('employee'),         controller.getHistory);
router.get ('/all',           auth, requireRole('admin', 'ceo'),     controller.getAllToday);
router.get ('/report',        auth, requireRole('admin', 'ceo'),     controller.getReport);
router.patch('/:id',          auth, requireRole('admin', 'ceo'),     controller.overrideRecord);

module.exports = router;
