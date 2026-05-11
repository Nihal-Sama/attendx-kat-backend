const express     = require('express');
const router      = express.Router();
const auth        = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const controller  = require('../controllers/userController');

// Profile photo route now receives JSON body: { photo_url }
// The frontend uploads directly to ImageKit and passes back the CDN URL.

router.get ('/',                  auth, requireRole('admin', 'ceo'), controller.listUsers);
router.post('/',                  auth, requireRole('admin', 'ceo'), controller.createUser);
router.patch('/me/profile-photo', auth,                              controller.uploadProfilePhoto);
router.get ('/:id',               auth,                              controller.getUser);
router.put ('/:id',               auth,                              controller.updateUser);
router.delete('/:id',             auth, requireRole('admin', 'ceo'), controller.deactivateUser);

module.exports = router;