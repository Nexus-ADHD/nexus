-- 2026-10-18 security fix: extend-trial granted a fresh 7-day RevenueCat
-- promotional entitlement on EVERY call, so any signed-in user could keep
-- Pro free forever by replaying it. One extension per account: the edge
-- function reserves this row (primary key = user) BEFORE calling RevenueCat,
-- and only a definitive RevenueCat rejection releases it.
create table if not exists public.trial_extensions (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  status     text not null default 'granting' check (status in ('granting', 'granted', 'unknown')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Service role only: no client policies, and no direct grants to app roles.
alter table public.trial_extensions enable row level security;
revoke all on public.trial_extensions from anon, authenticated;
