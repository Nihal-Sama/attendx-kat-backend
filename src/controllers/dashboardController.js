// ============================================================
//  dashboardController.js
// ============================================================
const supabase = require('../supabaseClient');

const thisMonth = () => new Date().toISOString().slice(0, 7); // YYYY-MM
const today     = () => new Date().toISOString().split('T')[0];

// ── GET /api/dashboard/me — stats for the logged-in user ─────
async function getMyStats(req, res) {
  try {
    const userId = req.user.id;
    const month  = req.query.month || thisMonth();

    // Monthly attendance summary
    const { data: records, error: attError } = await supabase
      .from('attendance')
      .select('normal_hours, overtime_hours, total_hours, status, date')
      .eq('user_id', userId)
      .gte('date', `${month}-01`)
      .lte('date', `${month}-31`);

    if (attError) throw attError;

    const summary = {
      normal_hours:   records.reduce((s, r) => s + Number(r.normal_hours   || 0), 0),
      overtime_hours: records.reduce((s, r) => s + Number(r.overtime_hours || 0), 0),
      total_hours:    records.reduce((s, r) => s + Number(r.total_hours    || 0), 0),
      present_days:   records.filter(r => r.status === 'present').length,
      absent_days:    records.filter(r => r.status === 'absent').length,
      leave_days:     records.filter(r => r.status === 'on_leave').length,
    };

    // Today's record
    const { data: todayRecord } = await supabase
      .from('attendance')
      .select('*')
      .eq('user_id', userId)
      .eq('date', today())
      .maybeSingle();

    // Pending leaves (own)
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
        id:             req.user.id,
        name:           req.user.name,
        role:           req.user.role,
        total_leaves:   req.user.total_leaves,
        used_leaves:    req.user.used_leaves,
        leave_balance:  req.user.total_leaves - req.user.used_leaves,
      },
      month_summary:   summary,
      today:           todayRecord,
      pending_leaves:  pendingLeaves  || 0,
      unread_notifs:   unreadNotifs   || 0,
    });
  } catch (err) {
    console.error('[dashboardController.getMyStats]', err);
    res.status(500).json({ error: 'Failed to fetch dashboard stats.' });
  }
}

// ── GET /api/dashboard/overview — company-wide (admin/ceo) ───
async function getOverview(req, res) {
  try {
    const todayStr = today();
    const month    = req.query.month || thisMonth();

    // Today's team status
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

    const checkedInIds = new Set((todayAttendance || []).map(r => r.user_id));
    const presentCount = (todayAttendance || []).filter(r => r.status === 'present').length;
    const absentCount  = allEmployees.length - checkedInIds.size;

    // Pending leave requests
    const { count: pendingLeaves } = await supabase
      .from('leaves')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');

    // Monthly hours totals across all employees
    const { data: monthRecords, error: monthError } = await supabase
      .from('attendance')
      .select('normal_hours, overtime_hours, total_hours')
      .gte('date', `${month}-01`)
      .lte('date', `${month}-31`);
    if (monthError) throw monthError;

    const monthTotals = {
      normal_hours:   monthRecords.reduce((s, r) => s + Number(r.normal_hours   || 0), 0),
      overtime_hours: monthRecords.reduce((s, r) => s + Number(r.overtime_hours || 0), 0),
      total_hours:    monthRecords.reduce((s, r) => s + Number(r.total_hours    || 0), 0),
    };

    res.status(200).json({
      today: {
        date:           todayStr,
        total_employees: allEmployees.length,
        present:        presentCount,
        absent:         absentCount,
      },
      pending_leaves:  pendingLeaves || 0,
      month_totals:    monthTotals,
      month,
    });
  } catch (err) {
    console.error('[dashboardController.getOverview]', err);
    res.status(500).json({ error: 'Failed to fetch overview.' });
  }
}

module.exports = { getMyStats, getOverview };
