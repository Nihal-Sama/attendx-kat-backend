// ============================================================
//  auth.js
//  Verifies Supabase JWT and attaches the full user profile
//  to req.user for all downstream controllers.
//
//  Fix applied (Issue 2):
//  - Switched from .single() to .maybeSingle() to prevent
//    PGRST116 crash when the public.users row is not yet
//    visible due to Supabase connection pool replication lag.
//  - Added a retry loop (3 attempts, 300ms apart) to handle
//    the timing window between auth.users creation and
//    public.users row becoming readable.
//  - Returns clear, specific error messages for each failure
//    mode to make debugging easier.
// ============================================================
const supabase = require('../supabaseClient');

const MAX_RETRIES      = 3;
const RETRY_DELAY_MS   = 300;

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function authenticate(req, res, next) {
  try {

    // ── Step 1: Extract token ─────────────────────────────────
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Missing or malformed Authorization header.',
      });
    }

    const token = authHeader.split(' ')[1];

    if (!token || !token.trim()) {
      return res.status(401).json({
        error: 'Token is empty.',
      });
    }

    // ── Step 2: Verify token with Supabase Auth ───────────────
    // This confirms the JWT is valid and not expired.
    const {
      data: { user: authUser },
      error: authError,
    } = await supabase.auth.getUser(token);

    if (authError) {
      // Distinguish between expired and invalid tokens so the
      // frontend can decide whether to attempt a token refresh
      // or redirect straight to login.
      const isExpired = authError.message?.toLowerCase().includes('expired');
      return res.status(401).json({
        error:   isExpired ? 'Token has expired.' : 'Invalid token.',
        expired: isExpired,
      });
    }

    if (!authUser) {
      return res.status(401).json({ error: 'Invalid token.' });
    }

    // ── Step 3: Load profile with retry loop ──────────────────
    // Problem this solves:
    //   auth.users row is created by Supabase Auth instantly.
    //   public.users row is inserted by our Node server immediately
    //   after. However, Supabase uses PgBouncer connection pooling
    //   and in some cases (especially on the free tier) a read
    //   immediately after a write can miss the row due to
    //   replication lag or connection routing to a different pool
    //   node. This retry loop waits up to 900ms total before
    //   giving up, which resolves the vast majority of timing gaps.
    let profile  = null;
    let attempts = 0;

    while (attempts < MAX_RETRIES) {
      const { data, error: profileError } = await supabase
        .from('users')
        .select('*')
        .eq('id', authUser.id)
        .eq('is_active', true)
        .maybeSingle();    // returns null cleanly instead of throwing PGRST116

      if (profileError) {
        // A real database error — do not retry, fail immediately
        console.error('[auth middleware] Profile query error:', profileError.message);
        return res.status(500).json({ error: 'Authentication error.' });
      }

      if (data) {
        // Profile found — exit the retry loop
        profile = data;
        break;
      }

      // Profile not found yet — increment and wait before retry
      attempts++;

      if (attempts < MAX_RETRIES) {
        console.warn(
          `[auth middleware] Profile not found for ${authUser.id}, ` +
          `retrying (attempt ${attempts}/${MAX_RETRIES - 1})...`
        );
        await wait(RETRY_DELAY_MS);
      }
    }

    // ── Step 4: Final profile check ───────────────────────────
    if (!profile) {
      // After all retries, still no profile found.
      // Two possible causes:
      //   a) Account was deactivated (is_active = false)
      //   b) public.users row was never created (orphaned auth account)
      // Check without the is_active filter to distinguish them.
      const { data: inactiveCheck } = await supabase
        .from('users')
        .select('id, is_active')
        .eq('id', authUser.id)
        .maybeSingle();

      if (inactiveCheck && !inactiveCheck.is_active) {
        return res.status(401).json({
          error: 'This account has been deactivated. Please contact your administrator.',
        });
      }

      return res.status(401).json({
        error: 'User profile not found. Please contact your administrator.',
      });
    }

    // ── Step 5: Attach profile and continue ───────────────────
    req.user = profile;
    next();

  } catch (err) {
    console.error('[auth middleware] Unexpected error:', err);
    res.status(500).json({ error: 'Authentication error.' });
  }
}

module.exports = authenticate;