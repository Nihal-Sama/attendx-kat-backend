// ============================================================
//  notificationController.js
// ============================================================
const supabase = require('../supabaseClient');

// ── GET /api/notifications ────────────────────────────────────
async function getNotifications(req, res) {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const unread_count = data.filter(n => !n.is_read).length;
    res.status(200).json({ notifications: data, unread_count });
  } catch (err) {
    console.error('[notificationController.getNotifications]', err);
    res.status(500).json({ error: 'Failed to fetch notifications.' });
  }
}

// ── PATCH /api/notifications/read-all ────────────────────────
async function markAllRead(req, res) {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.user.id)
      .eq('is_read', false);

    if (error) throw error;
    res.status(200).json({ message: 'All notifications marked as read.' });
  } catch (err) {
    console.error('[notificationController.markAllRead]', err);
    res.status(500).json({ error: 'Failed to mark notifications as read.' });
  }
}

// ── PATCH /api/notifications/:id/read ────────────────────────
async function markOneRead(req, res) {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id); // ensure ownership

    if (error) throw error;
    res.status(200).json({ message: 'Notification marked as read.' });
  } catch (err) {
    console.error('[notificationController.markOneRead]', err);
    res.status(500).json({ error: 'Failed to mark notification as read.' });
  }
}

module.exports = { getNotifications, markAllRead, markOneRead };
