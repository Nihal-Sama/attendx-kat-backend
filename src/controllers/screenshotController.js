// ============================================================
//  screenshotController.js
//
//  Handles saving screenshot metadata sent from the frontend
//  after the frontend captures and uploads to ImageKit.
//
//  Flow:
//  1. Frontend captures frame from getDisplayMedia() stream
//  2. Frontend uploads the frame to ImageKit directly
//     using GET /api/imagekit/auth credentials
//  3. Frontend calls POST /api/screenshots with the CDN URL
//  4. This controller saves the URL + metadata to Supabase
//
//  Admin/CEO view:
//  GET /api/screenshots?user_id=&date= returns screenshots
//  for a specific employee on a specific day.
// ============================================================
const supabase = require('../supabaseClient');

// ── FIXED TIMEZONE FUNCTION ───────────────────────────────────
// Forces the server to evaluate "today" based on Indian Standard Time (IST)
// using the en-CA locale to natively output the required YYYY-MM-DD format.
const today = () => {
  return new Intl.DateTimeFormat('en-CA', { 
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
};


// ── POST /api/screenshots ─────────────────────────────────────
// Called by the frontend after it has uploaded a screenshot
// frame to ImageKit and received the CDN URL back.
// Body (JSON): { url, taken_at? }
// Only employees call this endpoint.
async function saveScreenshot(req, res) {
  try {
    const userId = req.user.id;
    const { url, taken_at } = req.body;

    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({
        error: 'A valid ImageKit CDN url is required.',
      });
    }

    const date       = today();
    const timestamp  = taken_at || new Date().toISOString();

    // ── GHOST SCREENSHOT FIX ──────────────────────────────────
    // Fetch today's attendance record. If they haven't checked in,
    // or if they have already checked out, block the screenshot.
    const { data: attendance, error: fetchError } = await supabase
      .from('attendance')
      .select('id, check_out_time')
      .eq('user_id', userId)
      .eq('date', date)
      .maybeSingle();

    if (fetchError || !attendance) {
      return res.status(403).json({ error: 'No active check-in found for today. Recording stopped.' });
    }
    
    if (attendance.check_out_time !== null) {
      return res.status(403).json({ error: 'You are already checked out. Recording stopped.' });
    }

    const { data, error } = await supabase
      .from('screenshots')
      .insert({
        user_id:       userId,
        attendance_id: attendance.id, // Safely guaranteed to exist now
        url,
        taken_at:      timestamp,
        date,
      })
      .select()
      .single();

    if (error) throw error;

    // Return minimal response — frontend does not need full details
    res.status(201).json({
      message: 'Screenshot saved.',
      id:      data.id,
      taken_at: data.taken_at,
    });
  } catch (err) {
    console.error('[screenshotController.saveScreenshot]', err);
    res.status(500).json({ error: 'Failed to save screenshot.' });
  }
}

// ── GET /api/screenshots ──────────────────────────────────────
// Admin/CEO fetches screenshots for a specific employee and date.
// Query params: ?user_id=<uuid>&date=YYYY-MM-DD
// Both params are required.
async function getScreenshots(req, res) {
  try {
    const { user_id, date } = req.query;

    if (!user_id || !date) {
      return res.status(400).json({
        error: 'user_id and date query parameters are required.',
      });
    }

    const { data, error } = await supabase
      .from('screenshots')
      .select(`
        id,
        url,
        taken_at,
        date,
        user:users!screenshots_user_id_fkey (
          id, name, avatar_initials, designation
        )
      `)
      .eq('user_id', user_id)
      .eq('date', date)
      .order('taken_at', { ascending: true });

    if (error) throw error;

    res.status(200).json({
      screenshots: data,
      count:       data.length,
      user_id,
      date,
    });
  } catch (err) {
    console.error('[screenshotController.getScreenshots]', err);
    res.status(500).json({ error: 'Failed to fetch screenshots.' });
  }
}


// ── GET /api/screenshots/summary ─────────────────────────────
// Admin/CEO gets a count of screenshots per employee for a
// given date. Used by the attendance panel to show a badge.
// Query params: ?date=YYYY-MM-DD  (defaults to today)
async function getScreenshotSummary(req, res) {
  try {
    const date = req.query.date || today();

    const { data, error } = await supabase
      .from('screenshots')
      .select('user_id')
      .eq('date', date);

    if (error) throw error;

    // Count per user_id
    const counts = {};
    (data || []).forEach(row => {
      counts[row.user_id] = (counts[row.user_id] || 0) + 1;
    });

    res.status(200).json({ date, counts });
  } catch (err) {
    console.error('[screenshotController.getScreenshotSummary]', err);
    res.status(500).json({ error: 'Failed to fetch screenshot summary.' });
  }
}


module.exports = { saveScreenshot, getScreenshots, getScreenshotSummary };