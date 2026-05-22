// ============================================================
//  services/reportService.js
//  Generates CSV strings from structured Supabase data.
//  The controller returns the CSV string to the frontend
//  which triggers a browser download — no file is written to disk.
// ============================================================

/**
 * Convert an array of objects to a CSV string.
 * @param {Array}  rows    - array of plain objects
 * @param {Array}  columns - column keys to include (in order)
 * @param {Array}  headers - display headers matching columns order
 * @returns {string}
 */
function toCSV(rows, columns, headers) {
  if (!rows || rows.length === 0) return 'No data available';

  const headerRow = headers.join(',');
  const dataRows  = rows.map(row =>
    columns.map(col => {
      const val = row[col] ?? '';
      const str = String(val).replace(/"/g, '""');
      return str.includes(',') || str.includes('\n') ? `"${str}"` : str;
    }).join(',')
  );

  return [headerRow, ...dataRows].join('\n');
}


/**
 * Attendance report CSV — works for single employee or all employees.
 * Records must have a `users` join object or a flat `user_name` field.
 *
 * @param {Array}  records - attendance rows
 * @param {string} title   - report title printed at the top
 * @returns {string}
 */
function generateAttendanceCSV(records, title = 'Attendance Report') {
  const columns = [
    'employee_name', 'date', 'check_in_time', 'check_out_time',
    'normal_hours', 'overtime_hours', 'total_hours',
    'break_minutes', 'status',
  ];
  const headers = [
    'Employee', 'Date', 'Check In', 'Check Out',
    'Normal Hours', 'Overtime', 'Total Hours',
    'Break (mins)', 'Status',
  ];

  const flat = (records || []).map(r => ({
    employee_name:  r.users?.name || r.user_name || 'N/A',
    date:           r.date,
    check_in_time:  r.check_in_time
      ? new Date(r.check_in_time).toLocaleTimeString()
      : '-',
    check_out_time: r.check_out_time
      ? new Date(r.check_out_time).toLocaleTimeString()
      : '-',
    normal_hours:   r.normal_hours   || 0,
    overtime_hours: r.overtime_hours || 0,
    total_hours:    r.total_hours    || 0,
    break_minutes:  r.break_minutes  || 0,
    status:         r.status         || '-',
  }));

  return `${title}\nGenerated: ${new Date().toLocaleString()}\n\n` +
         toCSV(flat, columns, headers);
}


/**
 * Leave report CSV.
 *
 * @param {Array}  leaves - leave rows (with users join or flat)
 * @param {string} title
 * @returns {string}
 */
function generateLeavesCSV(leaves, title = 'Leave Report') {
  const columns = [
    'employee_name', 'type', 'from_date', 'to_date',
    'days', 'status', 'reason', 'applied_on',
  ];
  const headers = [
    'Employee', 'Leave Type', 'From', 'To',
    'Days', 'Status', 'Reason', 'Applied On',
  ];

  const flat = (leaves || []).map(l => ({
    employee_name: l.users?.name || 'N/A',
    type:          l.type,
    from_date:     l.from_date,
    to_date:       l.to_date,
    days:          l.days,
    status:        l.status,
    reason:        l.reason,
    applied_on:    l.applied_on,
  }));

  return `${title}\nGenerated: ${new Date().toLocaleString()}\n\n` +
         toCSV(flat, columns, headers);
}


/**
 * Tasks report CSV.
 *
 * @param {Array}  tasks - task rows (with assignee join or flat)
 * @param {string} title
 * @returns {string}
 */
function generateTasksCSV(tasks, title = 'Tasks Report') {
  const columns = [
    'title', 'assigned_to', 'priority', 'status',
    'deadline', 'completed_at', 'ext_status',
  ];
  const headers = [
    'Task', 'Assigned To', 'Priority', 'Status',
    'Deadline', 'Completed At', 'Extension Status',
  ];

  const flat = (tasks || []).map(t => ({
    title:        t.title,
    assigned_to:  t.assignee?.name || 'N/A',
    priority:     t.priority,
    status:       t.status,
    deadline:     t.deadline
      ? new Date(t.deadline).toLocaleDateString()
      : '-',
    completed_at: t.completed_at
      ? new Date(t.completed_at).toLocaleDateString()
      : '-',
    ext_status:   t.ext_status || 'none',
  }));

  return `${title}\nGenerated: ${new Date().toLocaleString()}\n\n` +
         toCSV(flat, columns, headers);
}


module.exports = {
  generateAttendanceCSV,
  generateLeavesCSV,
  generateTasksCSV,
};