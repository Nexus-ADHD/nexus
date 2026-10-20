-- NEX-86: SMS broadcast infrastructure (Twilio + 10DLC + TCPA)
-- Tables: sms_opt_in (consent state machine), sms_send_log (delivery + cost audit).
-- All writes flow through edge functions with the service role; clients may
-- only read their own opt-in row. This keeps the TCPA consent trail
-- server-authoritative.

-- ── Opt-in state ─────────────────────────────────────────────────────────────
create table if not exists public.sms_opt_in (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  phone_number     text not null,
  opt_in_status    text not null default 'pending'
                     check (opt_in_status in ('pending', 'confirmed', 'stopped')),
  opt_in_method    text not null default 'double-opt-in'
                     check (opt_in_method in ('double-opt-in', 'manual')),
  opted_in_at      timestamptz not null default now(),
  confirmed_at     timestamptz,
  stopped_at       timestamptz,
  last_sms_sent_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint sms_opt_in_phone_e164_check
    check (phone_number ~ '^\+[1-9]\d{1,14}$')
);

-- Webhook looks rows up by inbound phone number (STOP/YES/HELP).
create index if not exists sms_opt_in_phone_idx
  on public.sms_opt_in (phone_number);
create index if not exists sms_opt_in_status_idx
  on public.sms_opt_in (opt_in_status);

alter table public.sms_opt_in enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sms_opt_in'
      and policyname = 'sms_opt_in_select_own'
  ) then
    create policy sms_opt_in_select_own
      on public.sms_opt_in for select
      using (auth.uid() = user_id);
  end if;
end $$;

-- No insert/update/delete policies on purpose: consent transitions happen
-- only via edge functions (service role), never from the client directly.

-- ── Send log (delivery receipts + cost-per-send for MRR-drag monitoring) ─────
create table if not exists public.sms_send_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  phone_number  text not null,
  message_sid   text unique,
  broadcast_key text,
  body_preview  text,
  segments      integer,
  status        text,
  price         numeric,
  price_unit    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Broadcast idempotency: one send per (user, broadcast_key).
create index if not exists sms_send_log_broadcast_idx
  on public.sms_send_log (broadcast_key, user_id);
create index if not exists sms_send_log_message_sid_idx
  on public.sms_send_log (message_sid);

-- Service-role only: RLS on, no policies.
alter table public.sms_send_log enable row level security;
