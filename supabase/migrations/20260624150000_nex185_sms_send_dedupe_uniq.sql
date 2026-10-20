-- NEX-185: make per-user SMS broadcast dedupe a real guarantee.
--
-- NEX-86 created a NON-unique index on sms_send_log (broadcast_key, user_id),
-- so the broadcast functions' pre-SELECT dedupe is racy: a concurrent or manual
-- re-run can double-send (a real cost + A2P-reputation hit on paid SMS).
--
-- Replace it with a UNIQUE index. We deliberately rely on the default
-- NULLS DISTINCT (NOT `NULLS NOT DISTINCT`, available since PG15 / Supabase is
-- PG15+): the test-send rows (user_id IS NULL, written by send-sms-broadcast's
-- #test path) stay unconstrained, while only real (broadcast_key, non-null
-- user_id) pairs become unique. Both SMS broadcast functions treat a 23505 on
-- insert as "already sent → skip", so the index hardens idempotency instead of
-- erroring.
--
-- If this CREATE ever fails on pre-existing duplicate (broadcast_key, user_id)
-- rows, de-duplicate first (keep the earliest by created_at) and re-run.

create unique index if not exists sms_send_log_broadcast_user_uniq
  on public.sms_send_log (broadcast_key, user_id);

-- The old non-unique index is now redundant (the unique one serves the same
-- (broadcast_key, user_id) lookups the dedupe pre-SELECT uses).
drop index if exists public.sms_send_log_broadcast_idx;
