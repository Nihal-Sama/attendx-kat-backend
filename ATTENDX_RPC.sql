-- ============================================================
--  ATTENDX_RPC.sql
--  Run this SEPARATELY in Supabase SQL Editor AFTER the main
--  ATTENDX_DATABASE.sql script has been executed.
--
--  This creates the atomic increment function used by the
--  leave approval flow in leaveController.js to prevent
--  race conditions when two approvals happen simultaneously.
-- ============================================================

CREATE OR REPLACE FUNCTION public.increment_used_leaves(
  p_user_id UUID,
  p_days    INT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.users
  SET used_leaves = used_leaves + p_days
  WHERE id = p_user_id;
$$;
