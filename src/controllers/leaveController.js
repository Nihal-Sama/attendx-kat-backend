// ============================================================
//  leaveController.js
// ============================================================
const supabase                       = require('../supabaseClient');
const { countWorkingDays }           = require('../services/leaveService');
const { createNotifications }        = require('../services/notifService');

// ── POST /api/leaves ─────────────────────────────────────────
async function applyLeave(req, res) {
  try {
    const { type, from_date, to_date, reason } = req.body;
    if (!type || !from_date || !to_date || !reason) {
      return res.status(400).json({ error: 'type, from_date, to_date and reason are required.' });
    }

    const todayStr = new Date().toISOString().split('T')[0];
    if (from_date < todayStr) {
      return res.status(400).json({ error: 'from_date cannot be in the past.' });
    }
    if (to_date < from_date) {
      return res.status(400).json({ error: 'to_date must be on or after from_date.' });
    }

    const days = countWorkingDays(from_date, to_date);
    if (days === 0) {
      return res.status(400).json({ error: 'Selected dates contain no working days.' });
    }

    // Check leave balance for employees
    if (req.user.role === 'employee') {
      const remaining = req.user.total_leaves - req.user.used_leaves;
      if (days > remaining) {
        return res.status(400).json({
          error: `Insufficient leave balance. You have ${remaining} day(s) remaining.`,
        });
      }
    }

    const { data: leave, error: leaveError } = await supabase
      .from('leaves')
      .insert({
        user_id:   req.user.id,
        type,
        reason,
        from_date,
        to_date,
        days,
        status:    'pending',
      })
      .select()
      .single();

    if (leaveError) throw leaveError;

    // Notify all admins and CEOs
    const { data: notifTargets } = await supabase
      .from('users')
      .select('id')
      .in('role', ['admin', 'ceo'])
      .eq('is_active', true);

    if (notifTargets && notifTargets.length > 0) {
      await createNotifications(
        notifTargets.map(u => ({
          user_id:      u.id,
          text:         `${req.user.name} applied for ${type} (${days} day${days > 1 ? 's' : ''}).`,
          type:         'leave',
          triggered_by: req.user.id,
          reference_id: leave.id,
        }))
      );
    }

    res.status(201).json({ message: 'Leave request submitted.', leave });
  } catch (err) {
    console.error('[leaveController.applyLeave]', err);
    res.status(500).json({ error: 'Failed to apply for leave.' });
  }
}

// ── GET /api/leaves ──────────────────────────────────────────
async function listLeaves(req, res) {
  try {
    const { status } = req.query;
    let query = supabase
      .from('leaves')
      .select(`*, users!leaves_user_id_fkey ( id, name, avatar_initials, designation )`)
      .order('created_at', { ascending: false });

    // Employees see only their own; admin/ceo see all
    if (req.user.role === 'employee') {
      query = query.eq('user_id', req.user.id);
    }
    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.status(200).json({ leaves: data });
  } catch (err) {
    console.error('[leaveController.listLeaves]', err);
    res.status(500).json({ error: 'Failed to fetch leaves.' });
  }
}

// ── GET /api/leaves/:id ──────────────────────────────────────
async function getLeave(req, res) {
  try {
    const { data, error } = await supabase
      .from('leaves')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Leave not found.' });

    // Employees can only view their own
    if (req.user.role === 'employee' && data.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    res.status(200).json({ leave: data });
  } catch (err) {
    console.error('[leaveController.getLeave]', err);
    res.status(500).json({ error: 'Failed to fetch leave.' });
  }
}

// ── PATCH /api/leaves/:id/approve (CEO only) ─────────────────
async function approveLeave(req, res) {
  try {
    await _reviewLeave(req, res, 'approved');
  } catch (err) {
    console.error('[leaveController.approveLeave]', err);
    res.status(500).json({ error: 'Failed to approve leave.' });
  }
}

// ── PATCH /api/leaves/:id/reject (CEO only) ──────────────────
async function rejectLeave(req, res) {
  try {
    await _reviewLeave(req, res, 'rejected');
  } catch (err) {
    console.error('[leaveController.rejectLeave]', err);
    res.status(500).json({ error: 'Failed to reject leave.' });
  }
}

// ── Shared approve/reject logic ───────────────────────────────
async function _reviewLeave(req, res, newStatus) {
  const { id } = req.params;

  const { data: leave, error: fetchError } = await supabase
    .from('leaves')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !leave) return res.status(404).json({ error: 'Leave not found.' });
  if (leave.status !== 'pending') {
    return res.status(409).json({ error: `Leave is already ${leave.status}.` });
  }

  // ⚠️ CRITICAL: status + reviewed_by + reviewed_at MUST be in ONE update
  // to satisfy the chk_reviewed_fields DB constraint.
  const { data: updated, error: updateError } = await supabase
    .from('leaves')
    .update({
      status:      newStatus,
      reviewed_by: req.user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (updateError) throw updateError;

  // If approved: increment used_leaves on the employee
  if (newStatus === 'approved') {
    await supabase
      .from('users')
      .update({ used_leaves: leave.days })   // Supabase doesn't do SQL increments directly
      // Use RPC for atomic increment
      .eq('id', leave.user_id);

    // Atomic increment via raw SQL RPC (recommended — prevents race conditions)
    await supabase.rpc('increment_used_leaves', {
      p_user_id: leave.user_id,
      p_days:    leave.days,
    });
  }

  // Notify the employee
  await createNotifications([{
    user_id:      leave.user_id,
    text:         `Your ${leave.type} request (${leave.days} day${leave.days > 1 ? 's' : ''}) was ${newStatus} by the CEO.`,
    type:         'leave-update',
    triggered_by: req.user.id,
    reference_id: leave.id,
  }]);

  res.status(200).json({ message: `Leave ${newStatus}.`, leave: updated });
}

// ── DELETE /api/leaves/:id — cancel own pending leave ────────
async function cancelLeave(req, res) {
  try {
    const { data: leave, error: fetchError } = await supabase
      .from('leaves')
      .select('id, user_id, status')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !leave) return res.status(404).json({ error: 'Leave not found.' });
    if (leave.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    if (leave.status !== 'pending') {
      return res.status(409).json({ error: 'Only pending leave requests can be cancelled.' });
    }

    const { error } = await supabase.from('leaves').delete().eq('id', req.params.id);
    if (error) throw error;
    res.status(200).json({ message: 'Leave request cancelled.' });
  } catch (err) {
    console.error('[leaveController.cancelLeave]', err);
    res.status(500).json({ error: 'Failed to cancel leave.' });
  }
}

module.exports = { applyLeave, listLeaves, getLeave, approveLeave, rejectLeave, cancelLeave };
