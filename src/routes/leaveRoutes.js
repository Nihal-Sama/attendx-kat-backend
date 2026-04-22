const express     = require('express');
const router      = express.Router();
const auth        = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const controller  = require('../controllers/leaveController');

router.post  ('/',               auth, controller.applyLeave);
router.get   ('/',               auth, controller.listLeaves);
router.get   ('/:id',            auth, controller.getLeave);
router.patch ('/:id/approve',    auth, requireRole('ceo'), controller.approveLeave);
router.patch ('/:id/reject',     auth, requireRole('ceo'), controller.rejectLeave);
router.delete('/:id',            auth, controller.cancelLeave);

module.exports = router;
