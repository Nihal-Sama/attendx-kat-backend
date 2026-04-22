// ============================================================
//  auth.js — Verify Supabase JWT and attach user to req
// ============================================================
const supabase = require('../supabaseClient');

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
    }

    const token = authHeader.split(' ')[1];

    // Verify the token with Supabase Auth
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authUser) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    // Load the full user profile (includes role, is_active, etc.)
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('*')
      .eq('id', authUser.id)
      .eq('is_active', true)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'User account not found or deactivated.' });
    }

    req.user = profile;  // { id, name, email, role, must_reset_password, ... }
    next();
  } catch (err) {
    console.error('[auth middleware]', err);
    res.status(500).json({ error: 'Authentication error.' });
  }
}

module.exports = authenticate;
