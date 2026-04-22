// ============================================================
//  leaveService.js — Calculate working days between two dates
//  Counts Mon–Fri only, inclusive of both endpoints.
// ============================================================
const { eachDayOfInterval, isWeekend, parseISO } = require('date-fns');

/**
 * Count working days (Mon–Fri) between from_date and to_date (inclusive).
 * @param {string} fromDate - YYYY-MM-DD
 * @param {string} toDate   - YYYY-MM-DD
 * @returns {number}
 */
function countWorkingDays(fromDate, toDate) {
  const days = eachDayOfInterval({
    start: parseISO(fromDate),
    end:   parseISO(toDate),
  });
  return days.filter(d => !isWeekend(d)).length;
}

module.exports = { countWorkingDays };
