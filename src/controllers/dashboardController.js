// ============================================================
//  dashboardController.js
// ============================================================
const supabase = require('../supabaseClient');
const { sumMonthlyTotals, MONTHLY_HOURS_TARGET } = require('../services/hoursService');

const thisMonth = () => new Date().toISOString().slice(0, 7);
// Fixed — IST based, consistent with screenshotController.js
const today = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year:     'numeric',
  month:    '2-digit',
  day:      '2-digit',
}).format(new Date());


// ── GET /api/dashboard/me ─────────────────────────────────────
async function getMyStats(req, res) {
  try {
    const userId = req.user.id;
    const month  = req.query.month || thisMonth();

    // Monthly attendance records
    const { data: records, error: attError } = await supabase
      .from('attendance')
      .select('normal_hours, overtime_hours, total_hours, status, date')
      .eq('user_id', userId)
      .gte('date', `${month}-01`)
      .lte('date', `${month}-31`);

    if (attError) throw attError;

    // All hour math is already stored — just sum the columns
    const summary = sumMonthlyTotals(records || []);

    // Today's record
    const { data: todayRecord } = await supabase
      .from('attendance')
      .select('*')
      .eq('user_id', userId)
      .eq('date', today())
      .maybeSingle();

    // Pending leave count (own)
    const { count: pendingLeaves } = await supabase
      .from('leaves')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'pending');

    // Unread notifications
    const { count: unreadNotifs } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    res.status(200).json({
      user: {
        id:                 req.user.id,
        name:               req.user.name,
        role:               req.user.role,
        paid_leaves_total:  req.user.paid_leaves_total,
        paid_leaves_used:   req.user.paid_leaves_used,
        paid_leave_balance: req.user.paid_leaves_total - req.user.paid_leaves_used,
      },
      month_summary:    { ...summary, monthly_target: MONTHLY_HOURS_TARGET },
      today:            todayRecord,
      pending_leaves:   pendingLeaves  || 0,
      unread_notifs:    unreadNotifs   || 0,
    });
  } catch (err) {
    console.error('[dashboardController.getMyStats]', err);
    res.status(500).json({ error: 'Failed to fetch dashboard stats.' });
  }
}


// ── GET /api/dashboard/overview ───────────────────────────────
async function getOverview(req, res) {
  try {
    const todayStr = today();
    const month    = req.query.month || thisMonth();

    const { data: todayAttendance, error: attError } = await supabase
      .from('attendance')
      .select('user_id, status, check_in_time, check_out_time')
      .eq('date', todayStr);
    if (attError) throw attError;

    const { data: allEmployees, error: empError } = await supabase
      .from('users')
      .select('id')
      .eq('role', 'employee')
      .eq('is_active', true);
    if (empError) throw empError;

    const checkedInIds  = new Set((todayAttendance || []).map(r => r.user_id));
    const presentCount  = (todayAttendance || []).filter(r => r.status === 'present').length;
    const absentCount   = allEmployees.length - checkedInIds.size;

    const { count: pendingLeaves } = await supabase
      .from('leaves')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');

    // Monthly totals across ALL employees
    const { data: monthRecords, error: monthError } = await supabase
      .from('attendance')
      .select('normal_hours, overtime_hours, total_hours, status')
      .gte('date', `${month}-01`)
      .lte('date', `${month}-31`);
    if (monthError) throw monthError;

    const monthTotals = sumMonthlyTotals(monthRecords || []);

    res.status(200).json({
      today: {
        date:             todayStr,
        total_employees:  allEmployees.length,
        present:          presentCount,
        absent:           absentCount,
      },
      pending_leaves:   pendingLeaves || 0,
      month_totals:     { ...monthTotals, monthly_target: MONTHLY_HOURS_TARGET },
      month,
    });
  } catch (err) {
    console.error('[dashboardController.getOverview]', err);
    res.status(500).json({ error: 'Failed to fetch overview.' });
  }
}


module.exports = { getMyStats, getOverview };