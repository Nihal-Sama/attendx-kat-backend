// ============================================================
//  routes/chatbotRoutes.js
//
//  Mount in your main app.js / server.js with:
//    const chatbotRoutes = require('./routes/chatbotRoutes');
//    app.use('/api/chatbot', chatbotRoutes);
//
//  → Final endpoint: POST /api/chatbot/message
// ============================================================
const express        = require('express');
const auth           = require('../middleware/auth');
const { sendMessage } = require('../controllers/chatbotController');

const router = express.Router();

router.post('/message', auth, sendMessage);

module.exports = router;