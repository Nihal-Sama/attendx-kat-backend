const supabase = require('../supabaseClient');

const today     = () => new Date().toISOString().split('T')[0];
const thisMonth = () => new Date().toISOString().slice(0, 7);

function getMonthRange(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const firstDay = `${yearMonth}-01`;
  const lastDay  = new Date(year, month, 0).toISOString().split('T')[0];
  return { firstDay, lastDay };
}

function parseDateRange(message) {
  const now      = new Date();
  const thisYear = now.getFullYear();
  const msg      = message.toLowerCase();

  if (/last month/i.test(msg)) {
    const d     = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const year  = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return getMonthRange(`${year}-${month}`);
  }
  if (/this month/i.test(msg)) return getMonthRange(thisMonth());
  if (/last week/i.test(msg)) {
    const day   = now.getDay();
    const start = new Date(now);
    start.setDate(now.getDate() - day - 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return {
      firstDay: start.toISOString().split('T')[0],
      lastDay:  end.toISOString().split('T')[0],
    };
  }

  const months = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december',
  ];
  for (let i = 0; i < months.length; i++) {
    if (new RegExp(`\\b${months[i]}\\b`).test(msg)) {
      const yearMatch = /\b(202\d)\b/.exec(msg);
      const year = yearMatch ? Number(yearMatch[1]) : thisYear;
      return getMonthRange(`${year}-${String(i + 1).padStart(2, '0')}`);
    }
  }

  return null;
}

// Fix 1: accepts optional dateRange so employee date-range queries work
async function getEmployeeContext(userId, dateRange = null) {
  const month    = thisMonth();
  const range    = dateRange || getMonthRange(month);
  const { firstDay, lastDay } = range;
  const todayStr = today();

  const [
    profileResult,
    attendanceResult,
    leavesResult,
    tasksResult,
    todayResult,
  ] = await Promise.allSettled([
    supabase
      .from('users')
      .select('id, name, email, designation, department, join_date, paid_leaves_total, paid_leaves_used, monthly_salary')
      .eq('id', userId)
      .single(),

    supabase
      .from('attendance')
      .select('date, check_in_time, check_out_time, normal_hours, overtime_hours, total_hours, break_minutes, status')
      .eq('user_id', userId)
      .gte('date', firstDay)
      .lte('date', lastDay)
      .order('date', { ascending: false }),

    supabase
      .from('leaves')
      .select('type, reason, from_date, to_date, days, status, applied_on')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20),

    supabase
      .from('tasks')
      .select('title, description, priority, status, deadline, completed_at, ext_status')
      .eq('assigned_to', userId)
      .order('deadline', { ascending: true }),

    supabase
      .from('attendance')
      .select('*')
      .eq('user_id', userId)
      .eq('date', todayStr)
      .maybeSingle(),
  ]);

  const profile    = profileResult.status    === 'fulfilled' ? profileResult.value.data   : null;
  const attendance = attendanceResult.status === 'fulfilled' ? attendanceResult.value.data : [];
  const leaves     = leavesResult.status     === 'fulfilled' ? leavesResult.value.data     : [];
  const tasks      = tasksResult.status      === 'fulfilled' ? tasksResult.value.data      : [];
  const todayRec   = todayResult.status      === 'fulfilled' ? todayResult.value.data      : null;

  const records = attendance || [];
  const summary = {
    normal_hours:   records.reduce((s, r) => s + Number(r.normal_hours   || 0), 0).toFixed(2),
    overtime_hours: records.reduce((s, r) => s + Number(r.overtime_hours || 0), 0).toFixed(2),
    total_hours:    records.reduce((s, r) => s + Number(r.total_hours    || 0), 0).toFixed(2),
    present_days:   records.filter(r => r.status === 'present').length,
    absent_days:    records.filter(r => r.status === 'absent').length,
    leave_days:     records.filter(r => r.status === 'on_leave').length,
    monthly_target: 180,
  };

  return {
    profile,
    today_attendance:   todayRec,
    monthly_summary:    summary,
    attendance_records: records,
    leaves,
    tasks,
    current_month: month,
    today:         todayStr,
  };
}

async function getAdminContext(dateRange = null) {
  const month    = thisMonth();
  const range    = dateRange || getMonthRange(month);
  const { firstDay, lastDay } = range;
  const todayStr = today();

  const [
    employeesResult,
    attendanceTodayResult,
    attendanceMonthResult,
    leavesResult,
    tasksResult,
    pendingLeavesResult,
  ] = await Promise.allSettled([
    supabase
      .from('users')
      .select('id, name, email, designation, department, join_date, role, paid_leaves_total, paid_leaves_used, monthly_salary, is_active')
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('attendance')
      .select(`
        user_id, date, check_in_time, check_out_time,
        normal_hours, overtime_hours, total_hours,
        break_minutes, status,
        users!attendance_user_id_fkey ( name, designation, department )
      `)
      .eq('date', todayStr),

    supabase
      .from('attendance')
      .select(`
        user_id, date, normal_hours, overtime_hours,
        total_hours, status,
        users!attendance_user_id_fkey ( name, designation )
      `)
      .gte('date', firstDay)
      .lte('date', lastDay)
      .order('date', { ascending: false }),

    supabase
      .from('leaves')
      .select(`
        type, reason, from_date, to_date, days, status, applied_on,
        users!leaves_user_id_fkey ( name, designation, department )
      `)
      .order('created_at', { ascending: false })
      .limit(50),

    supabase
      .from('tasks')
      .select(`
        title, description, priority, status, deadline,
        completed_at, ext_status,
        assignee:users!tasks_assigned_to_fkey ( name, designation ),
        creator:users!tasks_created_by_fkey ( name, role )
      `)
      .order('deadline', { ascending: true }),

    supabase
      .from('leaves')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
  ]);

  const employees       = employeesResult.status       === 'fulfilled' ? employeesResult.value.data       : [];
  const attendanceToday = attendanceTodayResult.status === 'fulfilled' ? attendanceTodayResult.value.data  : [];
  const attendanceMonth = attendanceMonthResult.status === 'fulfilled' ? attendanceMonthResult.value.data  : [];
  const leaves          = leavesResult.status          === 'fulfilled' ? leavesResult.value.data           : [];
  const tasks           = tasksResult.status           === 'fulfilled' ? tasksResult.value.data            : [];
  const pendingLeaves   = pendingLeavesResult.status   === 'fulfilled' ? pendingLeavesResult.value.count   : 0;

  const monthRecords = attendanceMonth || [];
  const companySummary = {
    total_normal_hours:   monthRecords.reduce((s, r) => s + Number(r.normal_hours   || 0), 0).toFixed(2),
    total_overtime_hours: monthRecords.reduce((s, r) => s + Number(r.overtime_hours || 0), 0).toFixed(2),
    total_hours_worked:   monthRecords.reduce((s, r) => s + Number(r.total_hours    || 0), 0).toFixed(2),
    total_present_days:   monthRecords.filter(r => r.status === 'present').length,
    total_absent_days:    monthRecords.filter(r => r.status === 'absent').length,
    total_leave_days:     monthRecords.filter(r => r.status === 'on_leave').length,
  };

  const employeeIds  = (employees || []).filter(e => e.role === 'employee').map(e => e.id);
  const checkedInIds = new Set((attendanceToday || []).map(r => r.user_id));
  const presentCount = (attendanceToday || []).filter(r => r.status === 'present').length;
  const absentCount  = employeeIds.filter(id => !checkedInIds.has(id)).length;

  return {
    employees,
    today_attendance:  attendanceToday,
    month_attendance:  attendanceMonth,
    company_summary:   companySummary,
    leaves,
    tasks,
    pending_leaves:    pendingLeaves || 0,
    today_summary: {
      total_employees: employeeIds.length,
      present:         presentCount,
      absent:          absentCount,
    },
    current_month: month,
    today:         todayStr,
  };
}

// Fix 2: passes dateRange through to getEmployeeContext
async function getEmployeeByNameContext(nameQuery, dateRange = null) {
  const { data: matchedUsers } = await supabase
    .from('users')
    .select('id, name, role')
    .eq('is_active', true)
    .eq('role', 'employee')
    .ilike('name', `%${nameQuery}%`);

  if (!matchedUsers || matchedUsers.length === 0) return null;

  return Promise.all(matchedUsers.map(u => getEmployeeContext(u.id, dateRange)));
}

module.exports = {
  getEmployeeContext,
  getAdminContext,
  getEmployeeByNameContext,
  parseDateRange,
};