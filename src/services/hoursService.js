// ============================================================
//  hoursService.js
//  Central calculation service for all working hour logic.
//
//  Rules encoded here:
//  - Daily working hours cap:    9 hours normal time
//  - Monthly target:             180 hours (used by dashboard)
//  - Break allowance per day:    80 minutes free
//    First 80 minutes of breaks count as working time.
//    Only break time BEYOND 80 minutes is deducted.
//  - Overtime:                   any hours beyond 9.00 per day
// ============================================================

const NORMAL_HOURS_CAP_PER_DAY  = 9.00;    // hours
const BREAK_ALLOWANCE_MINUTES   = 80;       // minutes free per day
const MONTHLY_HOURS_TARGET = 180;    // informational, used by dashboard

/**
 * Calculate all hour fields for one attendance record.
 *
 * @param {string|Date} checkInTime   - ISO timestamp of check-in
 * @param {string|Date} checkOutTime  - ISO timestamp of check-out
 * @param {number}      breakMinutes  - total accumulated break minutes for the day
 * @returns {{
 *   raw_hours:      number,
 *   normal_hours:   number,
 *   overtime_hours: number,
 *   total_hours:    number,
 *   deducted_break_minutes: number,
 *   free_break_minutes:     number
 * }}
 */
function calculateHours(checkInTime, checkOutTime, breakMinutes = 0) {
  const inMs  = new Date(checkInTime).getTime();
  const outMs = new Date(checkOutTime).getTime();

  if (isNaN(inMs) || isNaN(outMs) || outMs <= inMs) {
    return {
      raw_hours:              0.00,
      normal_hours:           0.00,
      overtime_hours:         0.00,
      total_hours:            0.00,
      deducted_break_minutes: 0,
      free_break_minutes:     0,
    };
  }

  // Total elapsed time in hours (raw, before any break deduction)
  const elapsedHours = (outMs - inMs) / (1000 * 60 * 60);

  // Break allowance: first 80 minutes are free (count as work time)
  // Only the excess beyond 80 minutes gets deducted
  const freeBreakMinutes     = Math.min(breakMinutes, BREAK_ALLOWANCE_MINUTES);
  const deductedBreakMinutes = Math.max(0, breakMinutes - BREAK_ALLOWANCE_MINUTES);
  const deductedBreakHours   = deductedBreakMinutes / 60;

  // Raw hours = elapsed time minus only the deductible break portion
  const rawHours = Math.max(0, elapsedHours - deductedBreakHours);

  // Normal hours: capped at 9.00 per day
  const normalHours = Math.min(rawHours, NORMAL_HOURS_CAP_PER_DAY);

  // Overtime: anything beyond 9.00
  const overtimeHours = Math.max(0, rawHours - NORMAL_HOURS_CAP_PER_DAY);

  return {
    raw_hours:              round2(rawHours),
    normal_hours:           round2(normalHours),
    overtime_hours:         round2(overtimeHours),
    total_hours:            round2(rawHours),   // total = raw (normal + overtime)
    deducted_break_minutes: deductedBreakMinutes,
    free_break_minutes:     freeBreakMinutes,
  };
}

/**
 * Sum up monthly totals from an array of attendance records.
 * Used by getMonthlySummary and getMyStats.
 *
 * @param {Array} records - attendance rows from Supabase
 * @returns {{
 *   normal_hours:   number,
 *   overtime_hours: number,
 *   total_hours:    number,
 *   present_days:   number,
 *   absent_days:    number,
 *   leave_days:     number
 * }}
 */
function sumMonthlyTotals(records) {
  return {
    normal_hours:   round2(records.reduce((s, r) => s + Number(r.normal_hours   || 0), 0)),
    overtime_hours: round2(records.reduce((s, r) => s + Number(r.overtime_hours || 0), 0)),
    total_hours:    round2(records.reduce((s, r) => s + Number(r.total_hours    || 0), 0)),
    present_days:   records.filter(r => r.status === 'present').length,
    absent_days:    records.filter(r => r.status === 'absent').length,
    leave_days:     records.filter(r => r.status === 'on_leave').length,
  };
}

/**
 * Calculate total accumulated break minutes from an array of
 * completed break rows (rows where break_end is not null).
 *
 * @param {Array} breakRows - rows from the breaks table
 * @returns {number} total minutes (integer)
 */
function sumBreakMinutes(breakRows) {
  if (!breakRows || breakRows.length === 0) return 0;

  const total = breakRows
    .filter(b => b.break_end !== null)
    .reduce((sum, b) => {
      const startMs = new Date(b.break_start).getTime();
      const endMs   = new Date(b.break_end).getTime();
      if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) return sum;
      return sum + (endMs - startMs) / (1000 * 60);
    }, 0);

  return Math.round(total);
}

/**
 * Round a number to 2 decimal places.
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  calculateHours,
  sumMonthlyTotals,
  sumBreakMinutes,
  MONTHLY_HOURS_TARGET,
  NORMAL_HOURS_CAP_PER_DAY,
  BREAK_ALLOWANCE_MINUTES,
};