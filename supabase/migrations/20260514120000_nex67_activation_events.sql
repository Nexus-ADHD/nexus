-- ────────────────────────────────────────────────────────────────────────────
-- NEX-67: Activation event instrumentation
--
-- Defines the raw event log, per-user-per-day rollup, and activation rule:
--   "Logged a habit AND cleared a to-do on three consecutive days."
--
-- Storage:
--   nexus_events             — raw event log (one row per habit_logged or
--                              todo_cleared)
--   nexus_activation_daily   — per-user per-day rollup, auto-maintained by
--                              the trigger below
--   nexus_profiles.activated_at — single source of truth for whether a user
--                                  has hit the activation criterion
--
-- Activation is detected on the third consecutive qualifying day. A qualifying
-- day is one where the user logged at least one habit AND cleared at least
-- one to-do (both true on the same day_key in the user's local timezone).
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Raw event log ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.nexus_events (
  event_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_name  text        NOT NULL CHECK (event_name IN ('habit_logged', 'todo_cleared')),
  event_ts    timestamptz NOT NULL DEFAULT NOW(),
  day_key     date        NOT NULL,
  source      text
);

CREATE INDEX IF NOT EXISTS idx_nexus_events_user_day ON public.nexus_events (user_id, day_key);
CREATE INDEX IF NOT EXISTS idx_nexus_events_ts       ON public.nexus_events (event_ts);

ALTER TABLE public.nexus_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users insert own events" ON public.nexus_events;
CREATE POLICY "Users insert own events" ON public.nexus_events
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own events" ON public.nexus_events;
CREATE POLICY "Users read own events" ON public.nexus_events
  FOR SELECT USING (auth.uid() = user_id);

-- 2. Per-user-per-day rollup ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.nexus_activation_daily (
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day_key           date        NOT NULL,
  habit_log_count   int         NOT NULL DEFAULT 0,
  todo_clear_count  int         NOT NULL DEFAULT 0,
  qualifies         boolean     GENERATED ALWAYS AS (habit_log_count > 0 AND todo_clear_count > 0) STORED,
  updated_at        timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day_key)
);

CREATE INDEX IF NOT EXISTS idx_activation_daily_qualifies
  ON public.nexus_activation_daily (user_id, day_key)
  WHERE qualifies = true;

ALTER TABLE public.nexus_activation_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own rollup" ON public.nexus_activation_daily;
CREATE POLICY "Users read own rollup" ON public.nexus_activation_daily
  FOR SELECT USING (auth.uid() = user_id);

-- 3. Profile activation flag ────────────────────────────────────────────────
ALTER TABLE public.nexus_profiles ADD COLUMN IF NOT EXISTS activated_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_nexus_profiles_activated_at ON public.nexus_profiles (activated_at);

-- 4. Trigger function: maintain rollup + detect activation ──────────────────
CREATE OR REPLACE FUNCTION public.fn_apply_nexus_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_qualifying_days int;
BEGIN
  -- Upsert the per-day rollup
  INSERT INTO public.nexus_activation_daily (
    user_id, day_key, habit_log_count, todo_clear_count, updated_at
  )
  VALUES (
    NEW.user_id,
    NEW.day_key,
    CASE WHEN NEW.event_name = 'habit_logged' THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_name = 'todo_cleared' THEN 1 ELSE 0 END,
    NOW()
  )
  ON CONFLICT (user_id, day_key) DO UPDATE
    SET habit_log_count  = nexus_activation_daily.habit_log_count  + EXCLUDED.habit_log_count,
        todo_clear_count = nexus_activation_daily.todo_clear_count + EXCLUDED.todo_clear_count,
        updated_at       = NOW();

  -- Activation check (only if not already activated)
  IF NOT EXISTS (
    SELECT 1 FROM public.nexus_profiles
    WHERE user_id = NEW.user_id AND activated_at IS NOT NULL
  ) THEN
    -- Count qualifying days in the 3-day window ending at NEW.day_key.
    -- If exactly 3 rows in [day_key-2, day_key] all qualify, that's a
    -- 3-consecutive-day run.
    SELECT COUNT(*) INTO v_qualifying_days
    FROM public.nexus_activation_daily
    WHERE user_id   = NEW.user_id
      AND day_key   BETWEEN NEW.day_key - 2 AND NEW.day_key
      AND qualifies = true;

    IF v_qualifying_days >= 3 THEN
      UPDATE public.nexus_profiles
      SET    activated_at = NOW()
      WHERE  user_id      = NEW.user_id
        AND  activated_at IS NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_nexus_event ON public.nexus_events;
CREATE TRIGGER trg_apply_nexus_event
AFTER INSERT ON public.nexus_events
FOR EACH ROW
EXECUTE FUNCTION public.fn_apply_nexus_event();

-- 5. Activation funnel view ─────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.activation_funnel AS
SELECT
  COUNT(*)                                                                                AS total_signups,
  COUNT(*) FILTER (WHERE activated_at IS NOT NULL)                                        AS total_activated,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE activated_at IS NOT NULL) / NULLIF(COUNT(*), 0),
    1
  )                                                                                       AS activation_rate_pct,
  ROUND(
    PERCENTILE_CONT(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (activated_at - trial_start)) / 86400
    ) FILTER (WHERE activated_at IS NOT NULL)::numeric,
    1
  )                                                                                       AS median_days_to_activation
FROM public.nexus_profiles;
