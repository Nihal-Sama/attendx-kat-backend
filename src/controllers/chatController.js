// ============================================================
//  chatController.js
// ============================================================
const supabase = require('../supabaseClient');

// ── GET /api/chat/messages?page=1&limit=50 ───────────────────
async function getMessages(req, res) {
  try {
    const page   = parseInt(req.query.page  || '1');
    const limit  = parseInt(req.query.limit || '50');
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabase
      .from('messages')
      .select(`
        id, text, is_deleted, sent_at,
        users ( id, name, avatar_initials, role )
      `, { count: 'exact' })
      .eq('is_deleted', false)
      .order('sent_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.status(200).json({ messages: data, total: count, page, limit });
  } catch (err) {
    console.error('[chatController.getMessages]', err);
    res.status(500).json({ error: 'Failed to fetch messages.' });
  }
}

// ── POST /api/chat/messages ───────────────────────────────────
async function sendMessage(req, res) {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Message text is required.' });
    }

    const { data, error } = await supabase
      .from('messages')
      .insert({ user_id: req.user.id, text: text.trim() })
      .select(`
        id, text, is_deleted, sent_at,
        users ( id, name, avatar_initials, role )
      `)
      .single();

    if (error) throw error;
    // Supabase Realtime broadcasts this INSERT to all subscribers automatically
    res.status(201).json({ message: data });
  } catch (err) {
    console.error('[chatController.sendMessage]', err);
    res.status(500).json({ error: 'Failed to send message.' });
  }
}

// ── DELETE /api/chat/messages/:id — soft delete ───────────────
async function deleteMessage(req, res) {
  try {
    const { id } = req.params;
    const isAdminOrCeo = ['admin', 'ceo'].includes(req.user.role);

    // Fetch to verify ownership
    const { data: msg, error: fetchError } = await supabase
      .from('messages')
      .select('id, user_id')
      .eq('id', id)
      .single();

    if (fetchError || !msg) return res.status(404).json({ error: 'Message not found.' });
    if (!isAdminOrCeo && msg.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own messages.' });
    }

    const { error } = await supabase
      .from('messages')
      .update({ is_deleted: true })
      .eq('id', id);

    if (error) throw error;
    res.status(200).json({ message: 'Message deleted.' });
  } catch (err) {
    console.error('[chatController.deleteMessage]', err);
    res.status(500).json({ error: 'Failed to delete message.' });
  }
}

module.exports = { getMessages, sendMessage, deleteMessage };
