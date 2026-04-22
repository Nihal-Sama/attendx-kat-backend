// ============================================================
//  Supabase Admin Client (service_role key)
//  This client BYPASSES Row Level Security.
//  Use it only in server-side controllers — never expose it.
// ============================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

module.exports = supabase;
