-- ============================================================
--  AttendX — Full Database Provisioning Script (FINAL)
--  Order: Enums → Functions → Tables → Triggers → RLS
--  Compatible with: Supabase (PostgreSQL 15)
--  Storage: ImageKit URLs stored as TEXT — no Supabase Storage
--  Fixes applied:
--    ✔ get_auth_role() marked STABLE (prevents per-row re-execution)
--    ✔ fn_sync_break_minutes() marked SECURITY DEFINER
--    ✔ breaks table has RLS policies
--    ✔ leave_type enum values annotated
--    ✔ chk_reviewed_fields warning comment added
-- ============================================================


-- ============================================================
--  SECTION 1 — ENUMS
-- ============================================================

CREATE TYPE user_role     AS ENUM ('employee', 'admin', 'ceo');
CREATE TYPE attend_status AS ENUM ('present', 'absent', 'on_leave', 'holiday');

-- ⚠️  Values are case-sensitive and contain spaces.
--     Always pass exact strings from Node: 'Paid Leave', 'Sick Leave', etc.
CREATE TYPE leave_type    AS ENUM ('Paid Leave', 'Sick Leave', 'Casual Leave', 'Emergency Leave');
CREATE TYPE leave_status  AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE notif_type    AS ENUM ('leave', 'leave-update', 'attendance-alert', 'system');


-- ============================================================
--  SECTION 2 — SHARED FUNCTIONS
-- ============================================================

-- 2a. Auto-update updated_at on any table that has the column
CREATE OR REPLACE FUNCTION fn_update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- 2b. Recalculate break_minutes on the parent attendance row.
--     SECURITY DEFINER: runs with full table access regardless of who
--     triggered it, so employee RLS restrictions never interfere.
CREATE OR REPLACE FUNCTION fn_sync_break_minutes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE attendance
  SET break_minutes = (
    SELECT COALESCE(
      SUM(
        EXTRACT(EPOCH FROM (b.break_end - b.break_start)) / 60.0
      )::INT,
      0
    )
    FROM breaks b
    WHERE b.attendance_id = NEW.attendance_id
      AND b.break_end IS NOT NULL  -- only count completed breaks
  )
  WHERE id = NEW.attendance_id;
  RETURN NEW;
END;
$$;

-- 2c. Fetch the current user's role without triggering RLS recursion.
--     STABLE: result won't change within a single query — Postgres
--     caches it per statement instead of re-executing per row.
--     This is the fix for the performance trap in the original script.
CREATE OR REPLACE FUNCTION public.get_auth_role()
RETURNS user_role
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role FROM public.users WHERE id = auth.uid() LIMIT 1;
$$;


-- ============================================================
--  SECTION 3 — TABLES
-- ============================================================

-- ------------------------------------------------------------
--  3a. users
--  NOTE: Your Node.js backend uses the service_role key, which
--  bypasses RLS entirely, for ALL user creation via
--  supabase.auth.admin.createUser(). The insert RLS policy below
--  only matters for direct client calls (which you won't use).
-- ------------------------------------------------------------
CREATE TABLE public.users (
  id                  UUID        PRIMARY KEY
                                  REFERENCES auth.users(id) ON DELETE CASCADE,
  name                TEXT        NOT NULL,
  email               TEXT        NOT NULL UNIQUE,
  role                user_role   NOT NULL DEFAULT 'employee',
  designation         TEXT,
  department          TEXT,
  phone               TEXT,
  join_date           DATE,
  avatar_initials     TEXT,
  profile_photo_url   TEXT,         -- ImageKit CDN URL for profile photo
  paid_leaves_total   INT         NOT NULL DEFAULT 24,
  paid_leaves_used    INT         NOT NULL DEFAULT 0,
  monthly_salary      NUMERIC(12, 2),
  must_reset_password BOOLEAN     NOT NULL DEFAULT TRUE,
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_paid_leaves_used  CHECK (paid_leaves_used >= 0),
  CONSTRAINT chk_paid_leaves_total CHECK (paid_leaves_total >= 0)
);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION fn_update_updated_at();


-- ------------------------------------------------------------
--  3b. attendance
--  App code only ever writes: check_in_time, check_out_time,
--  break_minutes (kept in sync by the breaks trigger below).
--  Postgres computes all four hour columns automatically.
-- ------------------------------------------------------------
CREATE TABLE public.attendance (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID          NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  date                DATE          NOT NULL,

  -- Check-in
  check_in_time       TIMESTAMPTZ,
  check_in_photo_url  TEXT,         -- ImageKit URL
  check_in_lat        NUMERIC(10, 7),
  check_in_lng        NUMERIC(10, 7),

  -- Check-out
  check_out_time      TIMESTAMPTZ,
  check_out_photo_url TEXT,         -- ImageKit URL
  check_out_lat       NUMERIC(10, 7),
  check_out_lng       NUMERIC(10, 7),

  -- Kept in sync by fn_sync_break_minutes trigger on breaks table
  break_minutes       INT           NOT NULL DEFAULT 0,
  status              attend_status NOT NULL DEFAULT 'present',

  -- ── GENERATED HOUR COLUMNS ──────────────────────────────
  -- GREATEST(..., 0.00) guards against negative values from bad data.

  raw_hours      NUMERIC(6, 2) GENERATED ALWAYS AS (
    CASE
      WHEN check_in_time IS NOT NULL AND check_out_time IS NOT NULL
      THEN GREATEST(
             ROUND(
               (EXTRACT(EPOCH FROM (check_out_time - check_in_time)) / 3600.0)
               - (break_minutes::NUMERIC / 60.0),
             2),
           0.00)
      ELSE 0.00
    END
  ) STORED,

  normal_hours   NUMERIC(6, 2) GENERATED ALWAYS AS (
    CASE
      WHEN check_in_time IS NOT NULL AND check_out_time IS NOT NULL
      THEN LEAST(
             GREATEST(
               ROUND(
                 (EXTRACT(EPOCH FROM (check_out_time - check_in_time)) / 3600.0)
                 - (break_minutes::NUMERIC / 60.0),
               2),
             0.00),
           9.00)
      ELSE 0.00
    END
  ) STORED,

  overtime_hours NUMERIC(6, 2) GENERATED ALWAYS AS (
    CASE
      WHEN check_in_time IS NOT NULL AND check_out_time IS NOT NULL
      THEN GREATEST(
             ROUND(
               (EXTRACT(EPOCH FROM (check_out_time - check_in_time)) / 3600.0)
               - (break_minutes::NUMERIC / 60.0),
             2) - 9.00,
           0.00)
      ELSE 0.00
    END
  ) STORED,

  total_hours    NUMERIC(6, 2) GENERATED ALWAYS AS (
    CASE
      WHEN check_in_time IS NOT NULL AND check_out_time IS NOT NULL
      THEN GREATEST(
             ROUND(
               (EXTRACT(EPOCH FROM (check_out_time - check_in_time)) / 3600.0)
               - (break_minutes::NUMERIC / 60.0),
             2),
           0.00)
      ELSE 0.00
    END
  ) STORED,
  -- ── END GENERATED COLUMNS ──────────────────────────────

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_attendance_user_date UNIQUE (user_id, date),
  CONSTRAINT chk_checkout_after_checkin
    CHECK (check_out_time IS NULL OR check_in_time IS NULL OR check_out_time > check_in_time),
  CONSTRAINT chk_break_minutes CHECK (break_minutes >= 0)
);

CREATE INDEX idx_attendance_user_id ON public.attendance(user_id);
CREATE INDEX idx_attendance_date    ON public.attendance(date);

CREATE TRIGGER trg_attendance_updated_at
  BEFORE UPDATE ON public.attendance
  FOR EACH ROW EXECUTE FUNCTION fn_update_updated_at();


-- ------------------------------------------------------------
--  3c. breaks
-- ------------------------------------------------------------
CREATE TABLE public.breaks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_id UUID        NOT NULL REFERENCES public.attendance(id) ON DELETE CASCADE,
  break_start   TIMESTAMPTZ NOT NULL,
  break_end     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_break_end_after_start
    CHECK (break_end IS NULL OR break_end > break_start)
);

CREATE INDEX idx_breaks_attendance_id ON public.breaks(attendance_id);

-- Fires fn_sync_break_minutes after any insert or when break_end is updated
CREATE TRIGGER trg_sync_break_minutes
  AFTER INSERT OR UPDATE ON public.breaks
  FOR EACH ROW EXECUTE FUNCTION fn_sync_break_minutes();


-- ------------------------------------------------------------
--  3d. leaves
--  ⚠️  CRITICAL: When approving/rejecting, your Node controller MUST
--  update status + reviewed_by + reviewed_at in a SINGLE UPDATE call.
--  Doing it in two separate calls will violate chk_reviewed_fields
--  and cause a 500 error. See leaveController.js for correct pattern.
-- ------------------------------------------------------------
CREATE TABLE public.leaves (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type        leave_type   NOT NULL,
  reason      TEXT         NOT NULL,
  from_date   DATE         NOT NULL,
  to_date     DATE         NOT NULL,
  days        INT          NOT NULL,
  status      leave_status NOT NULL DEFAULT 'pending',
  applied_on  DATE         NOT NULL DEFAULT CURRENT_DATE,
  reviewed_by UUID         REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_to_date_after_from CHECK (to_date >= from_date),
  CONSTRAINT chk_days_positive      CHECK (days > 0),
  CONSTRAINT chk_reviewed_fields    CHECK (
    (status = 'pending'                    AND reviewed_by IS NULL  AND reviewed_at IS NULL)
    OR
    (status IN ('approved', 'rejected')    AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX idx_leaves_user_id ON public.leaves(user_id);
CREATE INDEX idx_leaves_status  ON public.leaves(status);

CREATE TRIGGER trg_leaves_updated_at
  BEFORE UPDATE ON public.leaves
  FOR EACH ROW EXECUTE FUNCTION fn_update_updated_at();


-- ------------------------------------------------------------
--  3e. messages  (group chat)
--  After running this script: go to Supabase Dashboard →
--  Database → Replication and enable Realtime on this table.
-- ------------------------------------------------------------
CREATE TABLE public.messages (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  text       TEXT        NOT NULL,
  is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_sent_at ON public.messages(sent_at DESC);


-- ------------------------------------------------------------
--  3f. notifications
--  After running this script: go to Supabase Dashboard →
--  Database → Replication and enable Realtime on this table.
-- ------------------------------------------------------------
CREATE TABLE public.notifications (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  text         TEXT        NOT NULL,
  type         notif_type  NOT NULL,
  is_read      BOOLEAN     NOT NULL DEFAULT FALSE,
  triggered_by UUID        REFERENCES public.users(id) ON DELETE SET NULL,
  reference_id UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX idx_notifications_is_read ON public.notifications(user_id, is_read);


-- ============================================================
--  SECTION 4 — ROW LEVEL SECURITY
--  The Node.js backend uses the service_role key → bypasses RLS.
--  These policies govern anon/authenticated client access only.
-- ============================================================

-- ------------------------------------------------------------
--  4a. users
-- ------------------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users: read own"
  ON public.users FOR SELECT TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "users: admin/ceo read all"
  ON public.users FOR SELECT TO authenticated
  USING (public.get_auth_role() IN ('admin', 'ceo'));

CREATE POLICY "users: admin/ceo insert"
  ON public.users FOR INSERT TO authenticated
  WITH CHECK (public.get_auth_role() IN ('admin', 'ceo'));

CREATE POLICY "users: update own"
  ON public.users FOR UPDATE TO authenticated
  USING  (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "users: admin/ceo update all"
  ON public.users FOR UPDATE TO authenticated
  USING (public.get_auth_role() IN ('admin', 'ceo'));


-- ------------------------------------------------------------
--  4b. attendance
-- ------------------------------------------------------------
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "attendance: employee read own"
  ON public.attendance FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "attendance: admin/ceo read all"
  ON public.attendance FOR SELECT TO authenticated
  USING (public.get_auth_role() IN ('admin', 'ceo'));

CREATE POLICY "attendance: employee insert own"
  ON public.attendance FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND public.get_auth_role() = 'employee'
  );

CREATE POLICY "attendance: employee update own"
  ON public.attendance FOR UPDATE TO authenticated
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "attendance: admin/ceo update all"
  ON public.attendance FOR UPDATE TO authenticated
  USING (public.get_auth_role() IN ('admin', 'ceo'));


-- ------------------------------------------------------------
--  4c. breaks
--  (Missing in original script — added here)
-- ------------------------------------------------------------
ALTER TABLE public.breaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "breaks: employee manage own"
  ON public.breaks FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.attendance a
      WHERE a.id = attendance_id AND a.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.attendance a
      WHERE a.id = attendance_id AND a.user_id = auth.uid()
    )
  );

CREATE POLICY "breaks: admin/ceo read all"
  ON public.breaks FOR SELECT TO authenticated
  USING (public.get_auth_role() IN ('admin', 'ceo'));


-- ------------------------------------------------------------
--  4d. leaves
-- ------------------------------------------------------------
ALTER TABLE public.leaves ENABLE ROW LEVEL SECURITY;

CREATE POLICY "leaves: employee read own"
  ON public.leaves FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "leaves: admin/ceo read all"
  ON public.leaves FOR SELECT TO authenticated
  USING (public.get_auth_role() IN ('admin', 'ceo'));

CREATE POLICY "leaves: insert own"
  ON public.leaves FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "leaves: employee delete own pending"
  ON public.leaves FOR DELETE TO authenticated
  USING (auth.uid() = user_id AND status = 'pending');

CREATE POLICY "leaves: ceo update"
  ON public.leaves FOR UPDATE TO authenticated
  USING  (public.get_auth_role() = 'ceo')
  WITH CHECK (public.get_auth_role() = 'ceo');


-- ------------------------------------------------------------
--  4e. messages
-- ------------------------------------------------------------
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "messages: authenticated read"
  ON public.messages FOR SELECT TO authenticated
  USING (auth.role() = 'authenticated');

CREATE POLICY "messages: authenticated insert"
  ON public.messages FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "messages: update own"
  ON public.messages FOR UPDATE TO authenticated
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "messages: admin/ceo update any"
  ON public.messages FOR UPDATE TO authenticated
  USING (public.get_auth_role() IN ('admin', 'ceo'));


-- ------------------------------------------------------------
--  4f. notifications
-- ------------------------------------------------------------
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications: read own"
  ON public.notifications FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "notifications: update own"
  ON public.notifications FOR UPDATE TO authenticated
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ============================================================
--  POST-SCRIPT CHECKLIST (do these manually in Supabase Dashboard)
--  [ ] Database → Replication → enable Realtime on: messages, notifications
--  [ ] Authentication → Providers → confirm Email/Password is ON
--  [ ] Project Settings → API → copy service_role key into your .env
-- ============================================================

-- ============================================================
--  END OF SCRIPT
-- ============================================================
