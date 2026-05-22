// ============================================================
//  leaveController.js
//
//  Leave type behaviour:
//  ┌─────────────────┬────────────────────────────────────────┐
//  │ Paid Leave      │ Deducts from paid_leaves_used.         │
//  │                 │ Max 15 days/year enforced here and      │
//  │                 │ at DB level (chk_paid_leaves_balance). │
//  ├─────────────────┼────────────────────────────────────────┤
//  │ Sick Leave      │ No balance deduction. Approved freely. │
//  │ Casual Leave    │ No hours earned on these days.         │
//  │ Emergency Leave │ Employee must make up hours via        │
//  │                 │ weekend work or daily overtime.        │
//  └─────────────────┴────────────────────────────────────────┘
// ============================================================
const supabase                = require('../supabaseClient');
const { countWorkingDays }    = require('../services/leaveService');
const { createNotifications } = require('../services/notifService');

const PAID_LEAVE = 'Paid Leave';


// ── POST /api/leaves ─────────────────────────────────────────
async function applyLeave(req, res) {
  try {
    const { type, from_date, to_date, reason } = req.body;

    if (!type || !from_date || !to_date || !reason) {
      return res.status(400).json({
        error: 'type, from_date, to_date, and reason are required.',
      });
    }

    // Validate leave type is one of the four allowed values
    const validTypes = ['Paid Leave', 'Sick Leave', 'Casual Leave', 'Emergency Leave'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        error: `Invalid leave type. Must be one of: ${validTypes.join(', ')}.`,
      });
    }

    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year:     'numeric',
      month:    '2-digit',
      day:      '2-digit',
    }).format(new Date());
    if (from_date < todayStr) {
      return res.status(400).json({ error: 'from_date cannot be in the past.' });
    }
    if (to_date < from_date) {
      return res.status(400).json({ error: 'to_date must be on or after from_date.' });
    }

    // Calculate working days (Mon–Fri only) using leaveService
    const days = countWorkingDays(from_date, to_date);
    if (days === 0) {
      return res.status(400).json({
        error: 'Selected dates contain no working days (Mon–Fri).',
      });
    }

    // ── Paid Leave: enforce the 15-day annual balance ─────────
    // Sick, Casual, and Emergency have no balance limit.
    if (type === PAID_LEAVE) {
      const { data: userRecord, error: userErr } = await supabase
        .from('users')
        .select('paid_leaves_total, paid_leaves_used')
        .eq('id', req.user.id)
        .single();

      if (userErr) throw userErr;

      const remaining = userRecord.paid_leaves_total - userRecord.paid_leaves_used;

      if (days > remaining) {
        return res.status(400).json({
          error: `Insufficient paid leave balance. ` +
                 `You have ${remaining} paid day(s) remaining ` +
                 `out of ${userRecord.paid_leaves_total} for this year.`,
        });
      }
    }

    // Insert the leave request
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

    // Notify all admins and CEOs — same pattern as before
    const { data: notifTargets } = await supabase
      .from('users')
      .select('id')
      .in('role', ['admin', 'ceo'])
      .eq('is_active', true);

    if (notifTargets && notifTargets.length > 0) {
      await createNotifications(
        notifTargets.map(u => ({
          user_id:      u.id,
          text:         `${req.user.name} applied for ${type} ` +
                        `(${days} working day${days > 1 ? 's' : ''}).`,
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
      .select(`
        *,
        users!leaves_user_id_fkey ( id, name, avatar_initials, designation )
      `)
      .order('created_at', { ascending: false });

    // Employees see only their own leaves
    if (req.user.role === 'employee') {
      query = query.eq('user_id', req.user.id);
    }

    // Optional filter by status
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

    if (error || !data) {
      return res.status(404).json({ error: 'Leave not found.' });
    }

    // Employees can only view their own leave
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

  // Load the leave request
  const { data: leave, error: fetchError } = await supabase
    .from('leaves')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !leave) {
    return res.status(404).json({ error: 'Leave not found.' });
  }
  if (leave.status !== 'pending') {
    return res.status(409).json({
      error: `This leave request is already ${leave.status}.`,
    });
  }

  // ⚠️  CRITICAL: status + reviewed_by + reviewed_at must be in
  //  ONE update call to satisfy the chk_reviewed_fields constraint.
  //  Splitting this into two updates will cause a 500.
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

  // ── Balance deduction: Paid Leave only ────────────────────
  // Sick, Casual, and Emergency leaves are approved without
  // touching any counter. The employee earns zero hours on
  // those days and must compensate via overtime or weekends.
  if (newStatus === 'approved' && leave.type === PAID_LEAVE) {
    const { error: rpcError } = await supabase.rpc(
      'increment_paid_leaves_used',
      {
        p_user_id: leave.user_id,
        p_days:    leave.days,
      }
    );

    if (rpcError) {
      // Log but do not block — leave status is already updated.
      // Admin can manually correct the balance if this fails.
      console.error('[leaveController._reviewLeave] RPC increment failed:', rpcError);
    }
  }

  // ── Notify the employee ───────────────────────────────────
  const isPaid = leave.type === PAID_LEAVE;
  const notifText = newStatus === 'approved'
    ? isPaid
      ? `Your ${leave.type} request (${leave.days} day${leave.days > 1 ? 's' : ''}) was approved by ${req.user.name}.`
      : `Your ${leave.type} request (${leave.days} day${leave.days > 1 ? 's' : ''}) was approved by ${req.user.name}. ` +
        `Remember: these hours are unpaid and must be made up via overtime or weekend work.`
    : `Your ${leave.type} request (${leave.days} day${leave.days > 1 ? 's' : ''}) was rejected by ${req.user.name}.`;

  await createNotifications([{
    user_id:      leave.user_id,
    text:         notifText,
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

    if (fetchError || !leave) {
      return res.status(404).json({ error: 'Leave not found.' });
    }
    if (leave.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    if (leave.status !== 'pending') {
      return res.status(409).json({
        error: 'Only pending leave requests can be cancelled.',
      });
    }

    const { error } = await supabase
      .from('leaves')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.status(200).json({ message: 'Leave request cancelled.' });
  } catch (err) {
    console.error('[leaveController.cancelLeave]', err);
    res.status(500).json({ error: 'Failed to cancel leave.' });
  }
}


module.exports = {
  applyLeave,
  listLeaves,
  getLeave,
  approveLeave,
  rejectLeave,
  cancelLeave,
};