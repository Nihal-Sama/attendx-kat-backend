// ============================================================
//  attendanceController.js
//
//  All hour calculations are now performed in the backend
//  via hoursService.js and written explicitly to the DB.
//  No GENERATED columns. No database triggers for breaks.
//
//  Break rule:   first 80 minutes free, excess deducted.
//  Normal hours: capped at 9.00 per day.
//  Overtime:     anything beyond 9.00.
// ============================================================
const supabase = require('../supabaseClient');
const {
  calculateHours,
  sumMonthlyTotals,
  sumBreakMinutes,
} = require('../services/hoursService');

// ── Office GPS anchor ─────────────────────────────────────────
// Replace with exact coordinates from Google Maps for
// Pakkar Tanver Leather Export before going to production.
const OFFICE_LAT        = 13.104026;
const OFFICE_LNG        = 80.250346;
const GEOFENCE_METRES   = 100;

// ── Haversine formula ─────────────────────────────────────────
function haversineMetres(lat1, lng1, lat2, lng2) {
  const R     = 6_371_000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Geofence guard ────────────────────────────────────────────
function geofenceError(lat, lng) {
  if (lat == null || lng == null) {
    return 'GPS coordinates are required to check in or out.';
  }
  const dist = haversineMetres(
    parseFloat(lat), parseFloat(lng),
    OFFICE_LAT, OFFICE_LNG
  );
  if (dist > GEOFENCE_METRES) {
    return `You are ${Math.round(dist)} m from the office. ` +
           `Check-in is only allowed within ${GEOFENCE_METRES} m.`;
  }
  return null;
}

const today = () => new Date().toISOString().split('T')[0];


// ── POST /api/attendance/checkin ─────────────────────────────
// Body (JSON): { lat, lng, photo_url }
// Hours are all 0.00 at check-in — calculated on check-out.
async function checkIn(req, res) {
  try {
    const userId = req.user.id;
    const date   = today();
    const { lat, lng, photo_url } = req.body;

    // ── 1. Geofence ───────────────────────────────────────────
    const geoErr = geofenceError(lat, lng);
    if (geoErr) return res.status(403).json({ error: geoErr });

    // ── 2. Photo required ─────────────────────────────────────
    if (!photo_url || typeof photo_url !== 'string' || !photo_url.trim()) {
      return res.status(400).json({
        error: 'A valid photo_url is required. Upload the photo to ImageKit first.',
      });
    }

    // ── 3. Prevent double check-in ────────────────────────────
    const { data: existing } = await supabase
      .from('attendance')
      .select('id')
      .eq('user_id', userId)
      .eq('date', date)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'Already checked in today.' });
    }

    // ── 4. Insert — hours start at 0, calculated on checkout ──
    const { data, error } = await supabase
      .from('attendance')
      .insert({
        user_id:                userId,
        date,
        check_in_time:          new Date().toISOString(),
        check_in_photo_url:     photo_url,
        check_in_lat:           lat,
        check_in_lng:           lng,
        status:                 'present',
        break_minutes:          0,
        break_allowance_minutes: 80,
        raw_hours:              0.00,
        normal_hours:           0.00,
        overtime_hours:         0.00,
        total_hours:            0.00,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ message: 'Checked in successfully.', attendance: data });
  } catch (err) {
    console.error('[attendanceController.checkIn]', err);
    res.status(500).json({ error: 'Check-in failed.' });
  }
}


// ── POST /api/attendance/checkout ────────────────────────────
// Body (JSON): { lat, lng, photo_url }
// This is where all hours are calculated and written to the DB.
async function checkOut(req, res) {
  try {
    const userId = req.user.id;
    const date   = today();
    const { lat, lng, photo_url } = req.body;

    // ── 1. Geofence ───────────────────────────────────────────
    const geoErr = geofenceError(lat, lng);
    if (geoErr) return res.status(403).json({ error: geoErr });

    // ── 2. Photo required ─────────────────────────────────────
    if (!photo_url || typeof photo_url !== 'string' || !photo_url.trim()) {
      return res.status(400).json({
        error: 'A valid photo_url is required. Upload the photo to ImageKit first.',
      });
    }

    // ── 3. Load today's attendance record ─────────────────────
    const { data: record, error: fetchError } = await supabase
      .from('attendance')
      .select('id, check_in_time, check_out_time, break_minutes')
      .eq('user_id', userId)
      .eq('date', date)
      .single();

    if (fetchError || !record) {
      return res.status(400).json({ error: 'No check-in record found for today.' });
    }
    if (record.check_out_time) {
      return res.status(409).json({ error: 'Already checked out today.' });
    }

    // ── 3b. Auto-close any open break at checkout ─────────────
  // If an employee forgets to end their break before checking
  // out, we close it automatically at checkout time.
  const { data: openBreak } = await supabase
    .from('breaks')
    .select('id')
    .eq('attendance_id', record.id)
    .is('break_end', null)
    .maybeSingle();

  if (openBreak) {
    await supabase
      .from('breaks')
      .update({ break_end: new Date().toISOString() })
      .eq('id', openBreak.id);
  }

    // ── 4. Fetch all completed breaks for today ───────────────
    // Re-sum from source rows to ensure break_minutes is
    // accurate even if a break was started but not properly ended.
    const { data: breakRows } = await supabase
      .from('breaks')
      .select('break_start, break_end')
      .eq('attendance_id', record.id)
      .not('break_end', 'is', null);

    const totalBreakMinutes = sumBreakMinutes(breakRows || []);

    // ── 5. Calculate all hours ────────────────────────────────
    const checkOutTime = new Date().toISOString();
    const hours = calculateHours(
      record.check_in_time,
      checkOutTime,
      totalBreakMinutes
    );

    // ── 6. Write everything to the DB in one update ───────────
    const { data, error } = await supabase
      .from('attendance')
      .update({
        check_out_time:         checkOutTime,
        check_out_photo_url:    photo_url,
        check_out_lat:          lat,
        check_out_lng:          lng,
        break_minutes:          totalBreakMinutes,
        raw_hours:              hours.raw_hours,
        normal_hours:           hours.normal_hours,
        overtime_hours:         hours.overtime_hours,
        total_hours:            hours.total_hours,
      })
      .eq('id', record.id)
      .select()
      .single();

    if (error) throw error;
    res.status(200).json({ message: 'Checked out successfully.', attendance: data });
  } catch (err) {
    console.error('[attendanceController.checkOut]', err);
    res.status(500).json({ error: 'Check-out failed.' });
  }
}


// ── POST /api/attendance/break/start ─────────────────────────
// No calculation here — just open a break row.
async function startBreak(req, res) {
  try {
    const userId = req.user.id;
    const date   = today();

    const { data: record, error: fetchError } = await supabase
      .from('attendance')
      .select('id, check_out_time')
      .eq('user_id', userId)
      .eq('date', date)
      .single();

    if (fetchError || !record) {
      return res.status(400).json({ error: 'No check-in record found for today.' });
    }
    if (record.check_out_time) {
      return res.status(400).json({ error: 'Cannot start a break after checking out.' });
    }

    // Ensure no open break already exists
    const { data: openBreak } = await supabase
      .from('breaks')
      .select('id')
      .eq('attendance_id', record.id)
      .is('break_end', null)
      .maybeSingle();

    if (openBreak) {
      return res.status(409).json({ error: 'A break is already in progress.' });
    }

    const { data, error } = await supabase
      .from('breaks')
      .insert({
        attendance_id: record.id,
        break_start:   new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ message: 'Break started.', break: data });
  } catch (err) {
    console.error('[attendanceController.startBreak]', err);
    res.status(500).json({ error: 'Failed to start break.' });
  }
}


// ── POST /api/attendance/break/end ───────────────────────────
// Closes the break row, recalculates all hours from scratch,
// and writes updated values to the attendance row.
async function endBreak(req, res) {
  try {
    const userId = req.user.id;
    const date   = today();

    // ── 1. Load today's attendance ────────────────────────────
    const { data: record, error: fetchError } = await supabase
      .from('attendance')
      .select('id, check_in_time, check_out_time')
      .eq('user_id', userId)
      .eq('date', date)
      .single();

    if (fetchError || !record) {
      return res.status(400).json({ error: 'No check-in record found for today.' });
    }

    // ── 2. Find the open break ────────────────────────────────
    const { data: openBreak, error: breakFetchError } = await supabase
      .from('breaks')
      .select('id, break_start')
      .eq('attendance_id', record.id)
      .is('break_end', null)
      .single();

    if (breakFetchError || !openBreak) {
      return res.status(400).json({ error: 'No active break found.' });
    }

    // ── 3. Close the break row ────────────────────────────────
    const breakEndTime = new Date().toISOString();
    const { data: closedBreak, error: closeError } = await supabase
      .from('breaks')
      .update({ break_end: breakEndTime })
      .eq('id', openBreak.id)
      .select()
      .single();

    if (closeError) throw closeError;

    // ── 4. Re-sum ALL completed breaks for today ──────────────
    // Fetch every completed break row (including the one just closed)
    // and sum from source rather than using the stored break_minutes.
    const { data: allBreaks } = await supabase
      .from('breaks')
      .select('break_start, break_end')
      .eq('attendance_id', record.id)
      .not('break_end', 'is', null);

    const totalBreakMinutes = sumBreakMinutes(allBreaks || []);

    // ── 5. Recalculate hours if already checked out ───────────
    // If the employee is still mid-shift (no checkout yet), we
    // update break_minutes but leave hour columns at 0 — they
    // will be fully calculated at checkout time.
    // If somehow endBreak is called after checkout (edge case),
    // recalculate and update hours immediately.
    const attendanceUpdate = { break_minutes: totalBreakMinutes };

    if (record.check_out_time) {
      const hours = calculateHours(
        record.check_in_time,
        record.check_out_time,
        totalBreakMinutes
      );
      attendanceUpdate.raw_hours      = hours.raw_hours;
      attendanceUpdate.normal_hours   = hours.normal_hours;
      attendanceUpdate.overtime_hours = hours.overtime_hours;
      attendanceUpdate.total_hours    = hours.total_hours;
    }

    const { data: updatedAttendance, error: attUpdateError } = await supabase
      .from('attendance')
      .update(attendanceUpdate)
      .eq('id', record.id)
      .select()
      .single();

    if (attUpdateError) throw attUpdateError;

    res.status(200).json({
      message:    'Break ended.',
      break:      closedBreak,
      attendance: updatedAttendance,
    });
  } catch (err) {
    console.error('[attendanceController.endBreak]', err);
    res.status(500).json({ error: 'Failed to end break.' });
  }
}


// ── GET /api/attendance/today ─────────────────────────────────
async function getToday(req, res) {
  try {
    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('date', today())
      .maybeSingle();

    if (error) throw error;
    res.status(200).json({ attendance: data });
  } catch (err) {
    console.error('[attendanceController.getToday]', err);
    res.status(500).json({ error: "Failed to fetch today's record." });
  }
}


// ── GET /api/attendance/summary ───────────────────────────────
async function getMonthlySummary(req, res) {
  try {
    const month  = req.query.month || today().slice(0, 7);
    const userId = req.query.user_id || req.user.id;

    if (req.user.role === 'employee' && userId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const { data, error } = await supabase
      .from('attendance')
      .select('normal_hours, overtime_hours, total_hours, status, date')
      .eq('user_id', userId)
      .gte('date', `${month}-01`)
      .lte('date', `${month}-31`);

    if (error) throw error;

    // sumMonthlyTotals reads the stored values — already calculated
    // by the backend at checkout time and persisted in the DB.
    const summary = sumMonthlyTotals(data || []);

    res.status(200).json({ month, summary });
  } catch (err) {
    console.error('[attendanceController.getMonthlySummary]', err);
    res.status(500).json({ error: 'Failed to fetch summary.' });
  }
}


// ── GET /api/attendance/history ───────────────────────────────
async function getHistory(req, res) {
  try {
    const month  = req.query.month || today().slice(0, 7);
    const page   = parseInt(req.query.page  || '1');
    const limit  = parseInt(req.query.limit || '31');
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabase
      .from('attendance')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.id)
      .gte('date', `${month}-01`)
      .lte('date', `${month}-31`)
      .order('date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.status(200).json({ records: data, total: count, page, limit });
  } catch (err) {
    console.error('[attendanceController.getHistory]', err);
    res.status(500).json({ error: 'Failed to fetch history.' });
  }
}


// ── GET /api/attendance/all — today all employees ─────────────
async function getAllToday(req, res) {
  try {
    const { data: employees, error: empError } = await supabase
      .from('users')
      .select('id, name, designation, department, avatar_initials, role')
      .eq('is_active', true)
      .eq('role', 'employee')
      .order('name');

    if (empError) throw empError;

    const { data: todayRecords, error: attError } = await supabase
      .from('attendance')
      .select('*')
      .eq('date', today());

    if (attError) throw attError;

    const recordMap = {};
    (todayRecords || []).forEach(r => { recordMap[r.user_id] = r; });

    const result = employees.map(emp => ({
      ...emp,
      today: recordMap[emp.id] || null,
    }));

    res.status(200).json({ employees: result });
  } catch (err) {
    console.error('[attendanceController.getAllToday]', err);
    res.status(500).json({ error: 'Failed to fetch team attendance.' });
  }
}


// ── GET /api/attendance/report ────────────────────────────────
async function getReport(req, res) {
  try {
    const month  = req.query.month   || today().slice(0, 7);
    const userId = req.query.user_id || null;

    let query = supabase
      .from('attendance')
      .select(`
        *,
        users ( id, name, designation, department, avatar_initials )
      `)
      .gte('date', `${month}-01`)
      .lte('date', `${month}-31`)
      .order('date', { ascending: false });

    if (userId) query = query.eq('user_id', userId);

    const { data, error } = await query;
    if (error) throw error;

    res.status(200).json({ records: data, month });
  } catch (err) {
    console.error('[attendanceController.getReport]', err);
    res.status(500).json({ error: 'Failed to fetch report.' });
  }
}


// ── PATCH /api/attendance/:id — admin/ceo override ────────────
// When an admin manually corrects check_in_time or check_out_time,
// hours are recalculated immediately here in the backend.
async function overrideRecord(req, res) {
  try {
    const { id } = req.params;

    const allowedFields = [
      'check_in_time', 'check_out_time', 'status',
      'check_in_photo_url', 'check_out_photo_url',
      'check_in_lat', 'check_in_lng',
      'check_out_lat', 'check_out_lng',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }

    // Load the existing record to merge times for recalculation
    const { data: existing, error: fetchError } = await supabase
      .from('attendance')
      .select('check_in_time, check_out_time, break_minutes')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Attendance record not found.' });
    }

    // Merge the incoming updates with the stored values
    const mergedCheckIn  = updates.check_in_time  || existing.check_in_time;
    const mergedCheckOut = updates.check_out_time || existing.check_out_time;
    const breakMins      = existing.break_minutes || 0;

    // Recalculate hours if both timestamps are now available
    if (mergedCheckIn && mergedCheckOut) {
      const hours = calculateHours(mergedCheckIn, mergedCheckOut, breakMins);
      updates.raw_hours      = hours.raw_hours;
      updates.normal_hours   = hours.normal_hours;
      updates.overtime_hours = hours.overtime_hours;
      updates.total_hours    = hours.total_hours;
    }

    const { data, error } = await supabase
      .from('attendance')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.status(200).json({ attendance: data });
  } catch (err) {
    console.error('[attendanceController.overrideRecord]', err);
    res.status(500).json({ error: 'Failed to override record.' });
  }
}


module.exports = {
  checkIn, checkOut,
  startBreak, endBreak,
  getToday, getMonthlySummary, getHistory,
  getAllToday, getReport, overrideRecord,
};