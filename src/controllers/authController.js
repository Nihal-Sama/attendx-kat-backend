// ============================================================
//  authController.js
// ============================================================
const supabase = require('../supabaseClient');

// ── POST /api/auth/login ─────────────────────────────────────
async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // Sign in via Supabase Auth
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Load profile
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .eq('is_active', true)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'Account not found or deactivated.' });
    }

    // If first login — tell the frontend to redirect to password reset
    if (profile.must_reset_password) {
      return res.status(200).json({
        forceReset:   true,
        access_token: data.session.access_token,
        user:         { id: profile.id, name: profile.name, role: profile.role },
      });
    }

    return res.status(200).json({
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
      user:          profile,
    });
  } catch (err) {
    console.error('[authController.login]', err);
    res.status(500).json({ error: 'Login failed.' });
  }
}

// ── POST /api/auth/logout ────────────────────────────────────
async function logout(req, res) {
  try {
    // Sign out from Supabase (invalidates the session server-side)
    await supabase.auth.signOut();
    res.status(200).json({ message: 'Logged out successfully.' });
  } catch (err) {
    console.error('[authController.logout]', err);
    res.status(500).json({ error: 'Logout failed.' });
  }
}

// ── GET /api/auth/me ─────────────────────────────────────────
async function me(req, res) {
  // req.user is already attached by auth middleware
  res.status(200).json({ user: req.user });
}

// ── PATCH /api/auth/reset-password ───────────────────────────
async function resetPassword(req, res) {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    // Update password in Supabase Auth
    const { error: authError } = await supabase.auth.admin.updateUserById(
      req.user.id,
      { password: new_password }
    );
    if (authError) throw authError;

    // Clear the force-reset flag
    const { error: dbError } = await supabase
      .from('users')
      .update({ must_reset_password: false })
      .eq('id', req.user.id);
    if (dbError) throw dbError;

    res.status(200).json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('[authController.resetPassword]', err);
    res.status(500).json({ error: 'Password reset failed.' });
  }
}

module.exports = { login, logout, me, resetPassword };
