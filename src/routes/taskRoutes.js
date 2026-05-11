// ============================================================
//  taskRoutes.js
//
//  ⚠️  Route ordering is intentional and must not change.
//  Sub-path routes (/:id/complete, /:id/extend,
//  /:id/extension-approval) are registered BEFORE the bare
//  /:id routes to prevent Express capturing the suffix as
//  part of the :id parameter.
// ============================================================
const express     = require('express');
const router      = express.Router();
const auth        = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const controller  = require('../controllers/taskController');

// ── Collection routes ─────────────────────────────────────────

// POST is open to all authenticated users.
// Admin/CEO can assign to any employee.
// Employees are forced to self-assign inside the controller.
router.post('/', auth, controller.createTask);
router.get ('/', auth, controller.listTasks);

// ── Sub-path routes ───────────────────────────────────────────
// Must be registered before bare /:id routes.

// Employee marks task as completed
router.patch(
  '/:id/complete',
  auth,
  requireRole('employee'),
  controller.completeTask
);

// Employee requests a deadline extension
router.post(
  '/:id/extend',
  auth,
  requireRole('employee'),
  controller.requestExtension
);

// Admin/CEO approves or rejects an extension request
router.patch(
  '/:id/extension-approval',
  auth,
  requireRole('admin', 'ceo'),
  controller.reviewExtension
);

// ── Single task routes ────────────────────────────────────────
// These come after sub-path routes to avoid :id swallowing suffixes.

router.get('/:id', auth, controller.getTask);

// PATCH and DELETE have no requireRole guard here —
// the controller handles role-specific logic and ownership checks.
router.patch ('/:id', auth, controller.updateTask);
router.delete('/:id', auth, controller.deleteTask);

module.exports = router;