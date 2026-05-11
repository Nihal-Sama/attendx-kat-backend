// ============================================================
//  taskController.js
//
//  Single-table schema: all extension fields live directly
//  on the tasks row.
//
//  ext_status lifecycle:
//    none → pending → approved | rejected
//    On next extension request: clears back to pending
//
//  Who can do what:
//  ┌─────────────────────────────┬──────────┬───────────────┐
//  │ Action                      │ Employee │ Admin / CEO   │
//  ├─────────────────────────────┼──────────┼───────────────┤
//  │ Create task (any assignee)  │    ✗     │      ✓        │
//  │ Create task (self only)     │    ✓     │      -        │
//  │ View own assigned/created   │    ✓     │      -        │
//  │ View all tasks              │    ✗     │      ✓        │
//  │ Edit own self-created task  │    ✓     │      -        │
//  │ Edit any task               │    ✗     │      ✓        │
//  │ Delete own self-created     │    ✓     │      -        │
//  │ Delete any task             │    ✗     │      ✓        │
//  │ Mark complete               │    ✓     │      ✗        │
//  │ Request extension           │    ✓     │      ✗        │
//  │ Approve / Reject extension  │    ✗     │      ✓        │
//  └─────────────────────────────┴──────────┴───────────────┘
// ============================================================
const supabase                = require('../supabaseClient');
const { createNotifications } = require('../services/notifService');


// ── POST /api/tasks ──────────────────────────────────────────
// Admin/CEO: assign to any active employee.
//            Body requires assigned_to.
// Employee:  always assigns to self regardless of body.
//            assigned_to in body is ignored.
async function createTask(req, res) {
  try {
    const { title, description, deadline, priority } = req.body;
    let   { assigned_to } = req.body;

    if (!title || !deadline) {
      return res.status(400).json({
        error: 'title and deadline are required.',
      });
    }

    if (new Date(deadline) <= new Date()) {
      return res.status(400).json({
        error: 'deadline must be a future date and time.',
      });
    }

    const isAdminOrCeo = ['admin', 'ceo'].includes(req.user.role);

    if (isAdminOrCeo) {
      // ── Admin / CEO path ──────────────────────────────────
      if (!assigned_to) {
        return res.status(400).json({
          error: 'assigned_to is required when creating a task as admin or CEO.',
        });
      }

      // Validate the assignee exists, is active, and is an employee
      const { data: assignee, error: assigneeError } = await supabase
        .from('users')
        .select('id, name, role')
        .eq('id', assigned_to)
        .eq('is_active', true)
        .single();

      if (assigneeError || !assignee) {
        return res.status(404).json({
          error: 'Assigned user not found or inactive.',
        });
      }
      if (assignee.role !== 'employee') {
        return res.status(400).json({
          error: 'Tasks can only be assigned to employees.',
        });
      }
    } else {
      // ── Employee path ─────────────────────────────────────
      // Force self-assignment regardless of what was sent in body.
      // The DB RLS policy enforces this as a second layer of defence.
      assigned_to = req.user.id;
    }

    const { data: task, error } = await supabase
      .from('tasks')
      .insert({
        title,
        description:  description || null,
        deadline,
        priority:     priority    || 'Medium',
        assigned_to,
        created_by:   req.user.id,
        status:       'pending',
        ext_status:   'none',
      })
      .select()
      .single();

    if (error) throw error;

    // Notify the assigned employee only when an admin/ceo creates the task.
    // No notification needed when an employee creates their own task —
    // they already know about it.
    if (isAdminOrCeo) {
      await createNotifications([{
        user_id:      assigned_to,
        text:         `You have been assigned a new task: "${title}". ` +
                      `Deadline: ${new Date(deadline).toLocaleDateString()}.`,
        type:         'task',
        triggered_by: req.user.id,
        reference_id: task.id,
      }]);
    }

    res.status(201).json({ message: 'Task created successfully.', task });
  } catch (err) {
    console.error('[taskController.createTask]', err);
    res.status(500).json({ error: 'Failed to create task.' });
  }
}


// ── GET /api/tasks ───────────────────────────────────────────
// Admin/CEO: all tasks with assignee and creator info.
// Employee:  tasks assigned to them OR created by them.
// Filters:   ?status=pending  ?priority=High
async function listTasks(req, res) {
  try {
    const { status, priority } = req.query;
    const isAdminOrCeo = ['admin', 'ceo'].includes(req.user.role);

    let query = supabase
      .from('tasks')
      .select(`
        *,
        assignee:users!tasks_assigned_to_fkey (
          id, name, avatar_initials, designation
        ),
        creator:users!tasks_created_by_fkey (
          id, name, role
        )
      `)
      .order('deadline', { ascending: true });

    if (!isAdminOrCeo) {
      // Supabase .or() syntax for filtering on two columns
      query = query.or(
        `assigned_to.eq.${req.user.id},created_by.eq.${req.user.id}`
      );
    }

    if (status)   query = query.eq('status',   status);
    if (priority) query = query.eq('priority', priority);

    const { data, error } = await query;
    if (error) throw error;

    res.status(200).json({ tasks: data });
  } catch (err) {
    console.error('[taskController.listTasks]', err);
    res.status(500).json({ error: 'Failed to fetch tasks.' });
  }
}


// ── GET /api/tasks/:id ───────────────────────────────────────
async function getTask(req, res) {
  try {
    const { data: task, error } = await supabase
      .from('tasks')
      .select(`
        *,
        assignee:users!tasks_assigned_to_fkey (
          id, name, avatar_initials, designation
        ),
        creator:users!tasks_created_by_fkey (
          id, name, role
        )
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !task) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    // Employees can only view tasks they are assigned to or created
    if (
      req.user.role === 'employee' &&
      task.assigned_to !== req.user.id &&
      task.created_by  !== req.user.id
    ) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    res.status(200).json({ task });
  } catch (err) {
    console.error('[taskController.getTask]', err);
    res.status(500).json({ error: 'Failed to fetch task.' });
  }
}


// ── PATCH /api/tasks/:id ─────────────────────────────────────
// Admin/CEO: edit any field on any task.
// Employee:  edit title/description/deadline/priority on tasks
//            they created for themselves only.
async function updateTask(req, res) {
  try {
    const { id }       = req.params;
    const isAdminOrCeo = ['admin', 'ceo'].includes(req.user.role);

    const adminFields    = [
      'title', 'description', 'deadline',
      'priority', 'assigned_to', 'status',
    ];
    const employeeFields = [
      'title', 'description', 'deadline', 'priority',
    ];

    const allowedFields = isAdminOrCeo ? adminFields : employeeFields;

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }

    if (updates.deadline && new Date(updates.deadline) <= new Date()) {
      return res.status(400).json({
        error: 'New deadline must be a future date and time.',
      });
    }

    // For employees: verify they own the task before allowing any edit
    if (!isAdminOrCeo) {
      const { data: existing, error: fetchError } = await supabase
        .from('tasks')
        .select('id, created_by, assigned_to')
        .eq('id', id)
        .single();

      if (fetchError || !existing) {
        return res.status(404).json({ error: 'Task not found.' });
      }
      if (
        existing.created_by !== req.user.id ||
        existing.assigned_to !== req.user.id
      ) {
        return res.status(403).json({
          error: 'You can only edit tasks you created for yourself.',
        });
      }
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    res.status(200).json({ message: 'Task updated.', task: data });
  } catch (err) {
    console.error('[taskController.updateTask]', err);
    res.status(500).json({ error: 'Failed to update task.' });
  }
}


// ── DELETE /api/tasks/:id ─────────────────────────────────────
// Admin/CEO: delete any task.
// Employee:  delete only self-created tasks (created_by = assigned_to = self).
async function deleteTask(req, res) {
  try {
    const { id }       = req.params;
    const isAdminOrCeo = ['admin', 'ceo'].includes(req.user.role);

    if (!isAdminOrCeo) {
      const { data: existing, error: fetchError } = await supabase
        .from('tasks')
        .select('id, created_by, assigned_to')
        .eq('id', id)
        .single();

      if (fetchError || !existing) {
        return res.status(404).json({ error: 'Task not found.' });
      }
      if (
        existing.created_by  !== req.user.id ||
        existing.assigned_to !== req.user.id
      ) {
        return res.status(403).json({
          error: 'You can only delete tasks you created for yourself.',
        });
      }
    }

    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.status(200).json({ message: 'Task deleted successfully.' });
  } catch (err) {
    console.error('[taskController.deleteTask]', err);
    res.status(500).json({ error: 'Failed to delete task.' });
  }
}


// ── PATCH /api/tasks/:id/complete ────────────────────────────
// Employee marks their assigned task as completed.
// Works for both admin-assigned tasks and self-created tasks.
async function completeTask(req, res) {
  try {
    const { id }   = req.params;
    const userId   = req.user.id;

    const { data: task, error: fetchError } = await supabase
      .from('tasks')
      .select('id, assigned_to, created_by, title, status')
      .eq('id', id)
      .single();

    if (fetchError || !task) {
      return res.status(404).json({ error: 'Task not found.' });
    }
    if (task.assigned_to !== userId) {
      return res.status(403).json({
        error: 'This task is not assigned to you.',
      });
    }
    if (task.status === 'completed') {
      return res.status(409).json({ error: 'Task is already completed.' });
    }

    const { data, error } = await supabase
      .from('tasks')
      .update({
        status:       'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Only notify the creator if they are a different person from the assignee.
    // No notification for self-created tasks — employee already knows.
    if (task.created_by && task.created_by !== userId) {
      await createNotifications([{
        user_id:      task.created_by,
        text:         `${req.user.name} completed the task: "${task.title}".`,
        type:         'task',
        triggered_by: userId,
        reference_id: id,
      }]);
    }

    res.status(200).json({ message: 'Task marked as completed.', task: data });
  } catch (err) {
    console.error('[taskController.completeTask]', err);
    res.status(500).json({ error: 'Failed to complete task.' });
  }
}


// ── POST /api/tasks/:id/extend ───────────────────────────────
// Employee requests a deadline extension on an assigned task.
// For self-created tasks, admins/CEOs are not notified since
// there is no external approver — employee can just edit the
// deadline directly via PATCH /api/tasks/:id instead.
// Body: { ext_reason, requested_deadline }
async function requestExtension(req, res) {
  try {
    const { id }   = req.params;
    const userId   = req.user.id;
    const { ext_reason, requested_deadline } = req.body;

    if (!ext_reason || !requested_deadline) {
      return res.status(400).json({
        error: 'ext_reason and requested_deadline are required.',
      });
    }

    const { data: task, error: fetchError } = await supabase
      .from('tasks')
      .select(
        'id, assigned_to, created_by, title, deadline, status, ext_status'
      )
      .eq('id', id)
      .single();

    if (fetchError || !task) {
      return res.status(404).json({ error: 'Task not found.' });
    }
    if (task.assigned_to !== userId) {
      return res.status(403).json({
        error: 'This task is not assigned to you.',
      });
    }
    if (task.status === 'completed') {
      return res.status(409).json({
        error: 'Cannot request an extension on a completed task.',
      });
    }

    // ── One-pending-at-a-time guard ───────────────────────────
    if (task.ext_status === 'pending') {
      return res.status(400).json({
        error: 'You already have a pending extension request for this task. ' +
               'Wait for it to be reviewed before submitting another.',
      });
    }

    if (new Date(requested_deadline) <= new Date(task.deadline)) {
      return res.status(400).json({
        error: 'Requested deadline must be later than the current deadline.',
      });
    }

    const { data, error } = await supabase
      .from('tasks')
      .update({
        ext_status:         'pending',
        ext_reason,
        requested_deadline,
        // Clear any previous review data so the new request is clean
        ext_reviewed_by:    null,
        ext_reviewed_at:    null,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    const isSelfCreated = task.created_by === userId;

    // Only notify admins/CEOs for tasks they assigned.
    // Self-created tasks have no external approver to notify.
    if (!isSelfCreated) {
      const { data: notifTargets } = await supabase
        .from('users')
        .select('id')
        .in('role', ['admin', 'ceo'])
        .eq('is_active', true);

      if (notifTargets && notifTargets.length > 0) {
        await createNotifications(
          notifTargets.map(u => ({
            user_id:      u.id,
            text:         `${req.user.name} requested a deadline extension ` +
                          `for task: "${task.title}".`,
            type:         'task',
            triggered_by: userId,
            reference_id: id,
          }))
        );
      }
    }

    res.status(200).json({
      message: isSelfCreated
        ? 'Extension request noted. Since this is your own task, ' +
          'you can also update the deadline directly via the edit option.'
        : 'Extension request submitted. Admin/CEO has been notified.',
      task: data,
    });
  } catch (err) {
    console.error('[taskController.requestExtension]', err);
    res.status(500).json({ error: 'Failed to submit extension request.' });
  }
}


// ── PATCH /api/tasks/:id/extension-approval ──────────────────
// Admin/CEO approves or rejects a pending extension request.
// Approved: requested_deadline becomes the new official deadline.
// Rejected: deadline stays unchanged.
// Body: { ext_status: 'approved' | 'rejected' }
async function reviewExtension(req, res) {
  try {
    const { id }         = req.params;
    const { ext_status } = req.body;

    if (!['approved', 'rejected'].includes(ext_status)) {
      return res.status(400).json({
        error: "ext_status must be 'approved' or 'rejected'.",
      });
    }

    const { data: task, error: fetchError } = await supabase
      .from('tasks')
      .select(
        'id, assigned_to, title, ext_status, requested_deadline'
      )
      .eq('id', id)
      .single();

    if (fetchError || !task) {
      return res.status(404).json({ error: 'Task not found.' });
    }
    if (task.ext_status !== 'pending') {
      return res.status(409).json({
        error: `No pending extension on this task. ` +
               `Current ext_status: "${task.ext_status}".`,
      });
    }

    const updates = {
      ext_status,
      ext_reviewed_by: req.user.id,
      ext_reviewed_at: new Date().toISOString(),
    };

    // Approved: promote the requested deadline to the live deadline.
    // Task status is intentionally left unchanged — frontend handles
    // overdue display dynamically by comparing deadline to Date.now().
    if (ext_status === 'approved') {
      updates.deadline = task.requested_deadline;
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Notify the assigned employee of the decision
    await createNotifications([{
      user_id:      task.assigned_to,
      text:         `Your deadline extension request for "${task.title}" ` +
                    `was ${ext_status} by ${req.user.name}.`,
      type:         'task',
      triggered_by: req.user.id,
      reference_id: id,
    }]);

    res.status(200).json({
      message: `Extension ${ext_status}.`,
      task:    data,
    });
  } catch (err) {
    console.error('[taskController.reviewExtension]', err);
    res.status(500).json({ error: 'Failed to review extension.' });
  }
}


module.exports = {
  createTask,
  listTasks,
  getTask,
  updateTask,
  deleteTask,
  completeTask,
  requestExtension,
  reviewExtension,
};