// ============================================================
//  markAbsent.js — Nightly cron: auto-insert absent records
//  Runs every weekday at 23:55 server time.
// ============================================================
const cron     = require('node-cron');
const supabase = require('../supabaseClient');

cron.schedule('55 23 * * 1-5', async () => {
  console.log('[cron] Running nightly absent-marking job...');

  // Fixed — IST based, consistent with screenshotController.js
  const today = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
  }).format(new Date());

  try {
    // 1. Get all active employees
    const { data: employees, error: empError } = await supabase
      .from('users')
      .select('id')
      .eq('role', 'employee')
      .eq('is_active', true);

    if (empError) throw empError;

    // 2. Get IDs of employees who already have a record today
    const { data: existing, error: existError } = await supabase
      .from('attendance')
      .select('user_id')
      .eq('date', today);

    if (existError) throw existError;

    const presentIds = new Set((existing || []).map(r => r.user_id));

    // 3. Build absent rows for employees with no record
    const absentRows = employees
      .filter(emp => !presentIds.has(emp.id))
      .map(emp => ({
        user_id: emp.id,
        date:    today,
        status:  'absent',
      }));

    if (absentRows.length === 0) {
      console.log('[cron] All employees accounted for. No absent rows needed.');
      return;
    }

    // 4. Insert absent rows (ignore conflicts — UNIQUE constraint on user_id+date)
    const { error: insertError } = await supabase
      .from('attendance')
      .insert(absentRows);

    if (insertError) throw insertError;

    console.log(`[cron] Marked ${absentRows.length} employee(s) as absent for ${today}.`);
  } catch (err) {
    console.error('[cron] markAbsent job failed:', err.message);
  }
});

console.log('✅  markAbsent cron job scheduled (weekdays at 23:55)');
