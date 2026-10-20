-- NEX-323 (NEX-298 C6): win-back at the cancel moment — RevenueCat webhook.
--
-- The repo's first server-side subscription ingestion point. Three tables:
-- an inbound webhook audit, an at-most-once send ledger, and a separate
-- failure audit (the NEX-319 lesson: the ledger is not an audit trail —
-- definitive-failure handling deletes ledger reservations so retries can
-- re-attempt, which would erase the only evidence a send failed).
--
-- Spec: docs/plans/nex-323-cancel-winback.md

-- ── 1. Inbound webhook audit ─────────────────────────────────────────────────
-- One row per RC event id. The insert is ON CONFLICT DO NOTHING and processing
-- CONTINUES on conflict: RC retries reuse the event id, and the ledger below
-- is the only side-effect dedupe — an audit dedupe must never burn a retry
-- whose first attempt failed after the audit row landed.
create table if not exists public.revenuecat_events (
  id                text primary key,          -- RC event id
  app_user_id       text,                      -- may be a $RCAnonymousID:* alias
  type              text,
  period_type       text,
  environment       text,
  cancel_reason     text,
  expiration_reason text,
  payload           jsonb not null,
  received_at       timestamptz not null default now()
);

create index if not exists revenuecat_events_received_idx
  on public.revenuecat_events (received_at desc);
create index if not exists revenuecat_events_app_user_idx
  on public.revenuecat_events (app_user_id);

-- Service-role only, matching sms_send_log: RLS on, no policies.
alter table public.revenuecat_events enable row level security;

-- ── 2. At-most-once send ledger ──────────────────────────────────────────────
-- Mirrors sms_send_log semantics (NEX-185): a reservation row (status
-- 'sending') is inserted BEFORE any side effect, so the unique index on
-- (kind, user_id) prevents a concurrent/duplicate send instead of only
-- detecting it after. Definitive rejections RELEASE (delete) the reservation
-- so a retry can re-attempt; ambiguous failures KEEP it (status 'unknown') so
-- a possibly-delivered message is never re-sent. The only residual is a rare
-- under-send (safe direction), never a double-send or a double-grant.
create table if not exists public.winback_send_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- trial_cancel_value: still-in-trial voluntary canceller, value email
  -- lapsed_offer:       lapsed-without-conversion, promotional grant + email
  kind        text not null
                check (kind in ('trial_cancel_value', 'lapsed_offer')),
  status      text not null default 'sending'
                check (status in ('sending', 'sent', 'unknown')),
  resend_id   text,
  granted_at  timestamptz,            -- set once the RC promotional grant lands
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists winback_send_log_kind_user_uniq
  on public.winback_send_log (kind, user_id);

alter table public.winback_send_log enable row level security;

-- ── 3. Append-only failure audit ─────────────────────────────────────────────
-- No unique constraints on purpose: every attempt is a fact, and the same
-- (kind, user_id) may legitimately fail more than once.
create table if not exists public.winback_send_attempt_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  kind          text,
  -- create_failed:   RC/Resend definitively rejected (side effect did NOT happen)
  -- ambiguous:       the request threw or 5xx'd; the side effect may have happened
  -- log_write_failed: the send landed but a follow-up ledger/log write failed
  phase         text not null
                  check (phase in ('create_failed', 'ambiguous', 'log_write_failed')),
  error_code    text,
  error_message text,
  created_at    timestamptz not null default now()
);

create index if not exists winback_send_attempt_log_created_idx
  on public.winback_send_attempt_log (created_at desc);
create index if not exists winback_send_attempt_log_kind_user_idx
  on public.winback_send_attempt_log (kind, user_id);

alter table public.winback_send_attempt_log enable row level security;
