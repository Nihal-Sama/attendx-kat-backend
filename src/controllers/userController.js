// ============================================================
//  userController.js
// ============================================================
const supabase = require('../supabaseClient');

// ── GET /api/users — list all active users ───────────────────
async function listUsers(req, res) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email, role, designation, department, phone, join_date, avatar_initials, total_leaves, used_leaves, is_active, created_at')
      .eq('is_active', true)
      .order('name');

    if (error) throw error;
    res.status(200).json({ users: data });
  } catch (err) {
    console.error('[userController.listUsers]', err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
}

// ── POST /api/users — create new user (admin/ceo only) ───────
async function createUser(req, res) {
  try {
    const {
      name, email, role = 'employee', designation, department,
      phone, join_date, monthly_salary, total_leaves = 24,
    } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required.' });
    }

    // Derive avatar initials from name (e.g. "Riya Sharma" → "RS")
    const avatar_initials = name
      .split(' ')
      .map(w => w[0]?.toUpperCase())
      .join('')
      .slice(0, 2);

    // 1. Create the Supabase Auth account with a default password
    const DEFAULT_PASSWORD = 'Attendx@123';
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password:       DEFAULT_PASSWORD,
      email_confirm:  true,               // skip email verification
      user_metadata:  { name, role, designation, department, avatar_initials },
    });

    if (authError) {
      if (authError.message.includes('already registered')) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }
      throw authError;
    }

    // 2. Insert into public.users (auth trigger may also do this — if you set
    //    up an auth trigger, remove or guard this insert to avoid duplicates)
    const { data: profile, error: dbError } = await supabase
      .from('users')
      .insert({
        id:              authData.user.id,
        name,
        email,
        role,
        designation,
        department,
        phone,
        join_date,
        avatar_initials,
        monthly_salary,
        total_leaves,
        must_reset_password: true,
      })
      .select()
      .single();

    if (dbError) {
      // If DB insert fails, clean up the auth user to avoid orphaned accounts
      await supabase.auth.admin.deleteUser(authData.user.id);
      throw dbError;
    }

    res.status(201).json({
      message: `Account created. Employee must change password on first login.`,
      user:    profile,
    });
  } catch (err) {
    console.error('[userController.createUser]', err);
    res.status(500).json({ error: 'Failed to create user.' });
  }
}

// ── GET /api/users/:id ───────────────────────────────────────
async function getUser(req, res) {
  try {
    const { id } = req.params;
    const requestingUser = req.user;

    // Employees can only view their own profile
    if (requestingUser.role === 'employee' && requestingUser.id !== id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'User not found.' });

    // Hide salary from employees viewing others (guard: only own or admin/ceo)
    if (requestingUser.role === 'employee' && requestingUser.id !== id) {
      delete data.monthly_salary;
    }

    res.status(200).json({ user: data });
  } catch (err) {
    console.error('[userController.getUser]', err);
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
}

// ── PUT /api/users/:id ───────────────────────────────────────
async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const requestingUser = req.user;

    // Employees may only update their own non-sensitive fields
    const isAdminOrCeo = ['admin', 'ceo'].includes(requestingUser.role);
    if (!isAdminOrCeo && requestingUser.id !== id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // Fields employees are allowed to update on their own profile
    const allowedForSelf   = ['phone', 'designation'];
    // Fields only admin/ceo can change
    const allowedForAdmin  = [
      'name', 'email', 'role', 'designation', 'department', 'phone',
      'join_date', 'monthly_salary', 'total_leaves', 'avatar_initials',
    ];

    const allowedFields = isAdminOrCeo ? allowedForAdmin : allowedForSelf;
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }

    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.status(200).json({ user: data });
  } catch (err) {
    console.error('[userController.updateUser]', err);
    res.status(500).json({ error: 'Failed to update user.' });
  }
}

// ── DELETE /api/users/:id — soft delete ──────────────────────
async function deactivateUser(req, res) {
  try {
    const { id } = req.params;

    if (id === req.user.id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    }

    // Soft delete: set is_active = false (preserves all history)
    const { error: dbError } = await supabase
      .from('users')
      .update({ is_active: false })
      .eq('id', id);
    if (dbError) throw dbError;

    // Also invalidate all active sessions for that user
    await supabase.auth.admin.deleteUser(id);

    res.status(200).json({ message: 'User account deactivated successfully.' });
  } catch (err) {
    console.error('[userController.deactivateUser]', err);
    res.status(500).json({ error: 'Failed to deactivate user.' });
  }
}

module.exports = { listUsers, createUser, getUser, updateUser, deactivateUser };
