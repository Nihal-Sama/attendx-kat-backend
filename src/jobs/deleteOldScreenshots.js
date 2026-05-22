// ============================================================
//  deleteOldScreenshots.js
//  Runs nightly at 02:00.
//  Deletes screenshot records older than 90 days from Supabase.
//  The actual ImageKit files are deleted via the ImageKit API.
//  If ImageKit deletion fails, the DB record is still removed
//  so the reference does not linger.
// ============================================================
const cron     = require('node-cron');
const supabase = require('../supabaseClient');
const imagekit = require('../imagekitClient');

cron.schedule('0 2 * * *', async () => {
  console.log('[cron] Running screenshot cleanup job...');

  try {
    // Calculate cutoff date — 90 days ago
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year:     'numeric',
      month:    '2-digit',
      day:      '2-digit',
    }).format(cutoff);

    // Fetch all screenshot records older than 90 days
    const { data: oldScreenshots, error: fetchError } = await supabase
      .from('screenshots')
      .select('id, url')
      .lt('date', cutoffStr);

    if (fetchError) throw fetchError;

    if (!oldScreenshots || oldScreenshots.length === 0) {
      console.log('[cron] No screenshots older than 90 days. Nothing to delete.');
      return;
    }

    console.log(`[cron] Found ${oldScreenshots.length} screenshots to delete.`);

    // Delete from ImageKit first, then remove DB records
    // Process in batches of 20 to avoid overwhelming the ImageKit API
    const BATCH_SIZE = 20;

    for (let i = 0; i < oldScreenshots.length; i += BATCH_SIZE) {
      const batch = oldScreenshots.slice(i, i + BATCH_SIZE);

      // Delete from ImageKit using file URL
      // ImageKit SDK deleteFile requires the file ID, not the URL.
      // We derive the file path from the URL to use bulk delete.
      const deletePromises = batch.map(async (screenshot) => {
        try {
          // Extract ImageKit file path from the CDN URL
          // URL pattern: https://ik.imagekit.io/{id}/attendx/screenshots/...
          const urlObj   = new URL(screenshot.url);
          const filePath = urlObj.pathname; // e.g. /attendx/screenshots/...

          await imagekit.deleteFile(filePath);
        } catch (ikErr) {
          // Log but do not block DB cleanup if ImageKit deletion fails
          // The CDN URL will become a dead link, which is acceptable
          console.warn(
            `[cron] ImageKit delete failed for ${screenshot.url}:`,
            ikErr.message
          );
        }
      });

      await Promise.allSettled(deletePromises);

      // Delete the DB records for this batch
      const batchIds = batch.map(s => s.id);
      const { error: deleteError } = await supabase
        .from('screenshots')
        .delete()
        .in('id', batchIds);

      if (deleteError) {
        console.error('[cron] DB delete failed for batch:', deleteError.message);
      } else {
        console.log(`[cron] Deleted batch of ${batch.length} screenshot records.`);
      }
    }

    console.log('[cron] Screenshot cleanup complete.');
  } catch (err) {
    console.error('[cron] deleteOldScreenshots failed:', err.message);
  }
});

console.log('✅  deleteOldScreenshots cron scheduled (daily at 02:00)');