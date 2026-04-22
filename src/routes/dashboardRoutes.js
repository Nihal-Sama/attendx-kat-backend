const express     = require('express');
const router      = express.Router();
const auth        = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const controller  = require('../controllers/dashboardController');

router.get('/me',       auth,                              controller.getMyStats);
router.get('/overview', auth, requireRole('admin', 'ceo'), controller.getOverview);

module.exports = router;
