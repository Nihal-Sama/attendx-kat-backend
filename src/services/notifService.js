// ============================================================
//  notifService.js — Create notifications in bulk
//  Uses service_role client so RLS never blocks inserts.
// ============================================================
const supabase = require('../supabaseClient');

/**
 * Create one or more notifications.
 * @param {Array<{user_id, text, type, triggered_by?, reference_id?}>} items
 */
async function createNotifications(items) {
  if (!items || items.length === 0) return;

  const { error } = await supabase.from('notifications').insert(items);
  if (error) {
    console.error('[notifService] Failed to create notifications:', error.message);
  }
}

module.exports = { createNotifications };
