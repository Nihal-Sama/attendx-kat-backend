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

    // Step 1 — Authenticate with Supabase
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Step 2 — Load full user profile
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .eq('is_active', true)
      .maybeSingle();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'Account not found or deactivated.' });
    }

    // Step 3 — Force reset path
    // Return early with just what the reset screen needs.
    // No bootstrap data needed here since the employee
    // cannot reach the dashboard until after they reset.
    if (profile.must_reset_password) {
      return res.status(200).json({
        forceReset:   true,
        access_token: data.session.access_token,
        user: {
          id:   profile.id,
          name: profile.name,
          role: profile.role,
        },
      });
    }

    // Step 4 — Pre-load all dashboard bootstrap data in parallel.
    // This runs BEFORE the response is sent so the frontend has
    // everything it needs to render the dashboard immediately on
    // arrival — no secondary API call required before first render.
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year:     'numeric',
      month:    '2-digit',
      day:      '2-digit',
    }).format(new Date());
    const month    = new Date().toISOString().slice(0, 7); // YYYY-MM
    const [year, mon] = month.split('-').map(Number);
    const lastDay  = new Date(year, mon, 0).toISOString().split('T')[0];

    const [
      todayResult,
      monthResult,
      notifResult,
      leaveResult,
    ] = await Promise.allSettled([
      // Today's attendance record
      supabase
        .from('attendance')
        .select('*')
        .eq('user_id', profile.id)
        .eq('date', todayStr)
        .maybeSingle(),

      // This month's attendance summary rows
      supabase
        .from('attendance')
        .select('normal_hours, overtime_hours, total_hours, status, date')
        .eq('user_id', profile.id)
        .gte('date', `${month}-01`)
        .lte('date', lastDay),

      // Unread notification count
      supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profile.id)
        .eq('is_read', false),

      // Pending leave count
      supabase
        .from('leaves')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profile.id)
        .eq('status', 'pending'),
    ]);

    // Step 5 — Extract results safely.
    // Promise.allSettled never throws — each result is either
    // { status: 'fulfilled', value } or { status: 'rejected', reason }.
    // We gracefully fall back to null / 0 if any query fails so a
    // single slow query never blocks the login response.
    const todayAttendance = todayResult.status === 'fulfilled'
      ? todayResult.value.data
      : null;

    const monthRecords = monthResult.status === 'fulfilled'
      ? (monthResult.value.data || [])
      : [];

    const unreadNotifs = notifResult.status === 'fulfilled'
      ? (notifResult.value.count || 0)
      : 0;

    const pendingLeaves = leaveResult.status === 'fulfilled'
      ? (leaveResult.value.count || 0)
      : 0;

    // Step 6 — Compute monthly summary on the backend
    // so the frontend can render progress bars immediately
    const monthlySummary = {
      normal_hours:   monthRecords.reduce((s, r) => s + Number(r.normal_hours   || 0), 0),
      overtime_hours: monthRecords.reduce((s, r) => s + Number(r.overtime_hours || 0), 0),
      total_hours:    monthRecords.reduce((s, r) => s + Number(r.total_hours    || 0), 0),
      present_days:   monthRecords.filter(r => r.status === 'present').length,
      absent_days:    monthRecords.filter(r => r.status === 'absent').length,
      leave_days:     monthRecords.filter(r => r.status === 'on_leave').length,
      monthly_target: 180,
    };

    // Step 7 — Send the complete response.
    // The frontend now has the full user profile AND all the data
    // the dashboard needs for its first render. No secondary call
    // is needed before showing content to the user.
    return res.status(200).json({
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
      user:          profile,
      bootstrap: {
        today_attendance: todayAttendance,
        monthly_summary:  monthlySummary,
        unread_notifs:    unreadNotifs,
        pending_leaves:   pendingLeaves,
        month:            month,
      },
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

// ── POST /api/auth/forgot-password ───────────────────────────
// Public. Triggers Supabase to email a reset link.
// Always returns 200 regardless of whether the email exists —
// prevents attackers from discovering registered emails.
async function forgotPassword(req, res) {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({
        error: 'A valid email address is required.',
      });
    }

    const redirectTo = `${process.env.FRONTEND_URL}/reset-password`;

    const { error } = await supabase.auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
      { redirectTo }
    );

    // Log internally but never expose to the client
    if (error) {
      console.error('[authController.forgotPassword]', error.message);
    }

    // Always return the same message whether email exists or not
    res.status(200).json({
      message: 'If an account with that email exists, a password reset link has been sent. Please check your inbox.',
    });
  } catch (err) {
    console.error('[authController.forgotPassword]', err);
    res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
  }
}


// ── POST /api/auth/confirm-reset ─────────────────────────────
// Public. Called after user clicks the Supabase email link and
// lands on /reset-password. Frontend extracts the access_token
// from the URL hash and sends it here with the new password.
// Body: { access_token, new_password }
async function confirmReset(req, res) {
  try {
    const { access_token, new_password } = req.body;

    if (!access_token || !new_password) {
      return res.status(400).json({
        error: 'access_token and new_password are required.',
      });
    }

    if (new_password.length < 8) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters.',
      });
    }

    // Verify the recovery token is valid
    const { data: { user }, error: userError } = await supabase.auth.getUser(
      access_token
    );

    if (userError || !user) {
      return res.status(401).json({
        error: 'This reset link is invalid or has expired. Please request a new one.',
      });
    }

    // Update the password
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      user.id,
      { password: new_password }
    );

    if (updateError) throw updateError;

    // Clear must_reset_password flag in case this was a first-login account
    await supabase
      .from('users')
      .update({ must_reset_password: false })
      .eq('id', user.id);

    res.status(200).json({
      message: 'Password updated successfully. You can now log in with your new password.',
    });
  } catch (err) {
    console.error('[authController.confirmReset]', err);
    res.status(500).json({ error: 'Password reset failed. Please try again.' });
  }
}

module.exports = { login, logout, me, resetPassword, forgotPassword, confirmReset };
