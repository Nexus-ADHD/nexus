-- NEX-323 sms-daily-quotes — pg_cron schedule
-- ---------------------------------------------------------------------------
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL). It is NOT an
-- auto-applied migration: it contains secrets, which must never be committed
-- to the repo. Replace the THREE placeholders below before running.
-- This mirrors the existing `weekly-summary-scheduler` cron setup.
--
-- Auth: the function REQUIRES the x-scheduler-secret header (it is
-- service-role backed and triggers paid SMS sends, so the platform JWT gate
-- alone is not enough). Set the secret first:
--   supabase secrets set SMS_DAILY_QUOTES_SCHEDULER_SECRET=<random>
--
-- Schedule: every 15 minutes. A slot becomes due when its local start time
-- passes and stays due for 3h (see pick.ts SLOT_CATCH_UP_MINUTES); the
-- per-(slot, day) dedupe key in sms_send_log makes every tick a safe retry,
-- so a retry or double-tick never double-sends and cap deferrals recover.
--
-- Kill switch: the function sends nothing until
--   supabase secrets set SMS_DAILY_QUOTES_ENABLED=true
--
-- Requires the pg_cron and pg_net extensions (already enabled for
-- email-scheduler).

-- Idempotent re-run: drop any prior job with this name first.
select cron.unschedule('nexus-sms-daily-quotes')
where exists (select 1 from cron.job where jobname = 'nexus-sms-daily-quotes');

select cron.schedule(
  'nexus-sms-daily-quotes',
  '*/15 * * * *',   -- every 15 minutes; slot matching happens per user, per local tz
  $$
  select net.http_post(
    url := '<SUPABASE_URL>/functions/v1/sms-daily-quotes',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <ANON_KEY>',
      'x-scheduler-secret', '<SMS_DAILY_QUOTES_SCHEDULER_SECRET>',
      'Content-Type', 'application/json'
    )
  );
  $$
);

-- Verify:  select jobname, schedule, active from cron.job where jobname = 'nexus-sms-daily-quotes';
-- Remove:  select cron.unschedule('nexus-sms-daily-quotes');
