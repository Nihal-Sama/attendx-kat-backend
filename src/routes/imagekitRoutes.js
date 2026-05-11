// ============================================================
//  imagekitRoutes.js
//  Provides a signed authentication token so the frontend
//  can upload directly to ImageKit without routing file
//  bytes through this server.
// ============================================================
const express   = require('express');
const router    = express.Router();
const auth      = require('../middleware/auth');
const imagekit  = require('../imagekitClient');

// ── GET /api/imagekit/auth ────────────────────────────────────
// Returns { token, expire, signature } for the frontend SDK.
// Protected — only authenticated users can request upload credentials.
router.get('/auth', auth, (req, res) => {
  try {
    const authParams = imagekit.getAuthenticationParameters();
    res.status(200).json(authParams);
  } catch (err) {
    console.error('[imagekitRoutes.auth]', err);
    res.status(500).json({ error: 'Failed to generate ImageKit auth parameters.' });
  }
});

module.exports = router;