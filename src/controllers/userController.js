// ============================================================
//  userController.js
// ============================================================
const supabase = require('../supabaseClient');
const imagekit = require('../imagekitClient');
// ── GET /api/users — list all active users ───────────────────
async function listUsers(req, res) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email, role, designation, department, phone, join_date, avatar_initials, paid_leaves_total, paid_leaves_used, is_active, created_at')
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
      phone, join_date, monthly_salary, paid_leaves_total = 15,
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
      password: DEFAULT_PASSWORD,
      email_confirm: true,               // skip email verification
      user_metadata: { name, role, designation, department, avatar_initials },
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
        id: authData.user.id,
        name,
        email,
        role,
        designation,
        department,
        phone,
        join_date,
        avatar_initials,
        monthly_salary,
        paid_leaves_total,
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
      user: profile,
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
    const allowedForSelf = ['phone', 'designation'];
    // Fields only admin/ceo can change
    const allowedForAdmin = [
      'name', 'email', 'role', 'designation', 'department', 'phone',
      'join_date', 'monthly_salary', 'paid_leaves_total', 'avatar_initials',
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

// ── PATCH /api/users/me/profile-photo ────────────────────────
// Body (JSON): { photo_url }
// Frontend uploads the photo directly to ImageKit and sends
// back the resulting CDN URL. This endpoint just persists it.
async function uploadProfilePhoto(req, res) {
  try {
    const { photo_url } = req.body;

    if (!photo_url || !photo_url.trim()) {
      return res.status(400).json({ error: 'photo_url is required.' });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ profile_photo_url: photo_url })
      .eq('id', req.user.id)
      .select('id, name, email, role, profile_photo_url')
      .single();

    if (error) throw error;

    res.status(200).json({
      message:           'Profile photo updated successfully.',
      profile_photo_url: data.profile_photo_url,
      user:              data,
    });
  } catch (err) {
    console.error('[userController.uploadProfilePhoto]', err);
    res.status(500).json({ error: 'Profile photo update failed.' });
  }
}

module.exports = { listUsers, createUser, getUser, updateUser, deactivateUser, uploadProfilePhoto };