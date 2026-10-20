-- Nexus weekly-summary-scheduler — pg_cron schedule
-- ---------------------------------------------------------------------------
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL). It is NOT an
-- auto-applied migration: it contains secrets, which must never be committed to
-- the repo. Replace the THREE placeholders below before running.
-- This mirrors how the existing `email-scheduler` cron was set up.
--
-- Auth: the function authorizes on the WEEKLY_SCHEDULER_SECRET shared secret
-- sent in the x-scheduler-secret header (set it first:
--   supabase secrets set WEEKLY_SCHEDULER_SECRET=<random>
-- and paste the SAME value below). The Authorization bearer is only there to
-- pass the platform's verify_jwt gateway; use the service_role key for it.
--
-- Schedule: daily at 13:00 UTC (~9 AM ET). The function gates per user on
-- weeklyEmailDay, so only users whose configured day == today (ET) are sent.
-- Idempotency is week-scoped inside the function (nexus_email_log key
-- weekly_summary_<ISO week>), so a daily run never double-sends.
--
-- Requires the pg_cron and pg_net extensions (already enabled for
-- email-scheduler).

-- Idempotent re-run: drop any prior job with this name first.
select cron.unschedule('nexus-daily-weekly-summary')
where exists (select 1 from cron.job where jobname = 'nexus-daily-weekly-summary');

select cron.schedule(
  'nexus-daily-weekly-summary',
  '0 13 * * *',   -- every day 13:00 UTC ≈ 9 AM ET
  $$
  select net.http_post(
    url := '<SUPABASE_URL>/functions/v1/weekly-summary-scheduler',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
      'x-scheduler-secret', '<WEEKLY_SCHEDULER_SECRET>',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('run_type', 'scheduled')
  );
  $$
);

-- Verify:  select jobname, schedule, active from cron.job where jobname = 'nexus-daily-weekly-summary';
-- Remove:  select cron.unschedule('nexus-daily-weekly-summary');
