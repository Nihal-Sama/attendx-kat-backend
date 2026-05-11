const express     = require('express');
const router      = express.Router();
const auth        = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const controller  = require('../controllers/attendanceController');

// All routes now receive plain JSON bodies.
// Photo upload is handled client-side via ImageKit SDK before
// calling these endpoints. The body contains { lat, lng, photo_url }.

router.post('/checkin',       auth, requireRole('employee'),     controller.checkIn);
router.post('/checkout',      auth, requireRole('employee'),     controller.checkOut);
router.post('/break/start',   auth, requireRole('employee'),     controller.startBreak);
router.post('/break/end',     auth, requireRole('employee'),     controller.endBreak);
router.get ('/today',         auth,                              controller.getToday);
router.get ('/summary',       auth,                              controller.getMonthlySummary);
router.get ('/history',       auth, requireRole('employee'),     controller.getHistory);
router.get ('/all',           auth, requireRole('admin', 'ceo'), controller.getAllToday);
router.get ('/report',        auth, requireRole('admin', 'ceo'), controller.getReport);
router.patch('/:id',          auth, requireRole('admin', 'ceo'), controller.overrideRecord);

module.exports = router;