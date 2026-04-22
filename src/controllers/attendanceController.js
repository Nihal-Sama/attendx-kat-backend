// ============================================================
//  attendanceController.js
// ============================================================
const supabase               = require('../supabaseClient');
const { uploadAttendancePhoto } = require('../services/storageService');

const today = () => new Date().toISOString().split('T')[0]; // YYYY-MM-DD

// ── POST /api/attendance/checkin ─────────────────────────────
async function checkIn(req, res) {
  try {
    const userId = req.user.id;
    const date   = today();

    // Prevent double check-in
    const { data: existing } = await supabase
      .from('attendance')
      .select('id')
      .eq('user_id', userId)
      .eq('date', date)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Already checked in today.' });
    }

    // Upload photo to ImageKit if provided
    let check_in_photo_url = null;
    if (req.file) {
      check_in_photo_url = await uploadAttendancePhoto(req.file.buffer, userId, 'checkin', date);
    }

    const { lat, lng } = req.body;

    const { data, error } = await supabase
      .from('attendance')
      .insert({
        user_id:           userId,
        date,
        check_in_time:     new Date().toISOString(),
        check_in_photo_url,
        check_in_lat:      lat   || null,
        check_in_lng:      lng   || null,
        status:            'present',
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
async function checkOut(req, res) {
  try {
    const userId = req.user.id;
    const date   = today();

    // Must have checked in today and not yet checked out
    const { data: record, error: fetchError } = await supabase
      .from('attendance')
      .select('id, check_in_time, check_out_time')
      .eq('user_id', userId)
      .eq('date', date)
      .single();

    if (fetchError || !record) {
      return res.status(400).json({ error: 'No check-in record found for today.' });
    }
    if (record.check_out_time) {
      return res.status(409).json({ error: 'Already checked out today.' });
    }

    // Upload photo if provided
    let check_out_photo_url = null;
    if (req.file) {
      check_out_photo_url = await uploadAttendancePhoto(req.file.buffer, userId, 'checkout', date);
    }

    const { lat, lng } = req.body;

    const { data, error } = await supabase
      .from('attendance')
      .update({
        check_out_time:     new Date().toISOString(),
        check_out_photo_url,
        check_out_lat:      lat  || null,
        check_out_lng:      lng  || null,
      })
      .eq('id', record.id)
      .select()
      .single();

    if (error) throw error;
    // DB GENERATED columns auto-recompute normal/overtime/total hours
    res.status(200).json({ message: 'Checked out successfully.', attendance: data });
  } catch (err) {
    console.error('[attendanceController.checkOut]', err);
    res.status(500).json({ error: 'Check-out failed.' });
  }
}

// ── POST /api/attendance/break/start ─────────────────────────
async function startBreak(req, res) {
  try {
    const userId = req.user.id;
    const date   = today();

    // Get today's attendance record
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
      .single();

    if (openBreak) {
      return res.status(409).json({ error: 'A break is already in progress.' });
    }

    const { data, error } = await supabase
      .from('breaks')
      .insert({ attendance_id: record.id, break_start: new Date().toISOString() })
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
async function endBreak(req, res) {
  try {
    const userId = req.user.id;
    const date   = today();

    // Get today's attendance
    const { data: record, error: fetchError } = await supabase
      .from('attendance')
      .select('id')
      .eq('user_id', userId)
      .eq('date', date)
      .single();

    if (fetchError || !record) {
      return res.status(400).json({ error: 'No check-in record found for today.' });
    }

    // Find the open break
    const { data: openBreak, error: breakFetchError } = await supabase
      .from('breaks')
      .select('id')
      .eq('attendance_id', record.id)
      .is('break_end', null)
      .single();

    if (breakFetchError || !openBreak) {
      return res.status(400).json({ error: 'No active break found.' });
    }

    // Set break_end — DB trigger fires and updates attendance.break_minutes
    // which then cascades into all GENERATED hour columns automatically
    const { data, error } = await supabase
      .from('breaks')
      .update({ break_end: new Date().toISOString() })
      .eq('id', openBreak.id)
      .select()
      .single();

    if (error) throw error;

    // Return updated attendance row with recalculated hours
    const { data: updatedAttendance } = await supabase
      .from('attendance')
      .select('*')
      .eq('id', record.id)
      .single();

    res.status(200).json({
      message:    'Break ended.',
      break:      data,
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
    res.status(200).json({ attendance: data }); // null if not checked in yet
  } catch (err) {
    console.error('[attendanceController.getToday]', err);
    res.status(500).json({ error: 'Failed to fetch today\'s record.' });
  }
}

// ── GET /api/attendance/summary ───────────────────────────────
async function getMonthlySummary(req, res) {
  try {
    const month  = req.query.month || today().slice(0, 7); // YYYY-MM
    const userId = req.query.user_id || req.user.id;

    // Employees can only see their own summary
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

    const summary = {
      normal_hours:   data.reduce((s, r) => s + Number(r.normal_hours   || 0), 0),
      overtime_hours: data.reduce((s, r) => s + Number(r.overtime_hours || 0), 0),
      total_hours:    data.reduce((s, r) => s + Number(r.total_hours    || 0), 0),
      present_days:   data.filter(r => r.status === 'present').length,
      absent_days:    data.filter(r => r.status === 'absent').length,
      leave_days:     data.filter(r => r.status === 'on_leave').length,
    };

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

// ── GET /api/attendance/all — today's status all employees ────
async function getAllToday(req, res) {
  try {
    // Get all active employees with their today's attendance if it exists
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

// ── GET /api/attendance/report — monthly report ───────────────
async function getReport(req, res) {
  try {
    const month   = req.query.month   || today().slice(0, 7);
    const userId  = req.query.user_id || null;

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

// ── PATCH /api/attendance/:id — admin/ceo manual override ────
async function overrideRecord(req, res) {
  try {
    const { id } = req.params;
    const allowed = [
      'check_in_time', 'check_out_time', 'status',
      'check_in_photo_url', 'check_out_photo_url',
      'check_in_lat', 'check_in_lng', 'check_out_lat', 'check_out_lng',
    ];

    const updates = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
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
  checkIn, checkOut, startBreak, endBreak,
  getToday, getMonthlySummary, getHistory,
  getAllToday, getReport, overrideRecord,
};
