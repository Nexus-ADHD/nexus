-- NEX-319: make SMS failures leave a durable trace, and give a never-confirmed
-- opt-in a way out.
--
-- Context: SMS shipped in NEX-86/181/185 and has never delivered a message. The
-- single row in sms_send_log reads status 'undelivered' with no error code,
-- because there was nowhere to put one — so the reason the channel is dark was
-- unrecoverable a month later. Three changes fix that class of blindness.

-- ── 1. Terminal-failure detail on the send log ───────────────────────────────
-- Twilio sends ErrorCode/ErrorMessage on the failed/undelivered status callback.
-- Nullable, no backfill: the historical row's reason is gone for good.
alter table public.sms_send_log
  add column if not exists error_code    integer,
  add column if not exists error_message text;

-- ── 2. Append-only attempt audit ─────────────────────────────────────────────
-- Deliberately a SEPARATE table rather than more columns on sms_send_log.
-- sms_send_log is the at-most-once dedupe LEDGER: sendBroadcastSmsOnce deletes
-- its reservation on a definitive Twilio rejection so a retry can re-attempt
-- (see _shared/sms.ts), and both broadcast functions treat the presence of ANY
-- row for a broadcast_key as "already sent". Recording failures in that table
-- would either suppress legitimate retries or force a partial unique index and
-- a rewrite of both prefilters. Keeping the audit alongside it means the send
-- semantics cannot regress.
--
-- No unique constraints on purpose: every attempt is a fact, and the same
-- (broadcast_key, user_id) may legitimately fail more than once.
create table if not exists public.sms_send_attempt_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  phone_number  text not null,
  broadcast_key text,
  -- create_failed:  Twilio definitively rejected at create time (not sent)
  -- ambiguous:      the request threw; Twilio may or may not have queued it
  -- callback_failed: Twilio accepted, then reported failed/undelivered async
  phase         text not null
                  check (phase in ('create_failed', 'ambiguous', 'callback_failed')),
  error_code    integer,
  error_message text,
  message_sid   text,
  created_at    timestamptz not null default now()
);

create index if not exists sms_send_attempt_log_created_idx
  on public.sms_send_attempt_log (created_at desc);
create index if not exists sms_send_attempt_log_broadcast_idx
  on public.sms_send_attempt_log (broadcast_key, user_id);

-- Service-role only, matching sms_send_log: RLS on, no policies.
alter table public.sms_send_attempt_log enable row level security;

-- ── 3. An exit for a wedged pending opt-in ───────────────────────────────────
-- The same-phone pending guard in sms-opt-in short-circuits every re-tap before
-- it can send another confirmation SMS, so a row whose confirmation text never
-- arrived is stuck forever on that number. 'expired' is a distinct state on
-- purpose: 'confirmed' would fabricate consent that was never given, and
-- 'stopped' would misrecord a user opt-out that never happened.
alter table public.sms_opt_in
  drop constraint if exists sms_opt_in_opt_in_status_check;
alter table public.sms_opt_in
  add constraint sms_opt_in_opt_in_status_check
    check (opt_in_status in ('pending', 'confirmed', 'stopped', 'expired'));
