const express      = require('express');
const router       = express.Router();
const auth         = require('../middleware/auth');
const requireRole  = require('../middleware/requireRole');
const controller   = require('../controllers/userController');

router.get ('/',     auth, requireRole('admin', 'ceo'), controller.listUsers);
router.post('/',     auth, requireRole('admin', 'ceo'), controller.createUser);
router.get ('/:id',  auth,                              controller.getUser);
router.put ('/:id',  auth,                              controller.updateUser);
router.delete('/:id',auth, requireRole('admin', 'ceo'), controller.deactivateUser);

module.exports = router;
