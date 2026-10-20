-- Baseline for a fresh project.
--
-- The original project created these three tables in the dashboard before
-- migrations were tracked, so later migrations assume they already exist.
-- This file recreates them from how the app and edge functions use them,
-- so `supabase db reset` works on a clean project. Every statement is
-- idempotent and safe to run against a project that already has them.

-- user_state: one row per user holding the app's synced state blob.
create table if not exists public.user_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  state_data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_state' and policyname = 'user_state_owner_select') then
    create policy user_state_owner_select on public.user_state for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_state' and policyname = 'user_state_owner_insert') then
    create policy user_state_owner_insert on public.user_state for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_state' and policyname = 'user_state_owner_update') then
    create policy user_state_owner_update on public.user_state for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_state' and policyname = 'user_state_owner_delete') then
    create policy user_state_owner_delete on public.user_state for delete using (auth.uid() = user_id);
  end if;
end;
$$;

-- nexus_profiles: email and trial lifecycle. Written only by the
-- upsert-profile edge function with the service role.
create table if not exists public.nexus_profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  email        text,
  name         text,
  plan_type    text,
  subscribed   boolean not null default false,
  trial_start  timestamptz,
  trial_end    timestamptz,
  purchased_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.nexus_profiles enable row level security;

-- nexus_email_log: one row per lifecycle email sent, used to avoid resends.
create table if not exists public.nexus_email_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  email_key  text not null,
  sent_at    timestamptz not null default now(),
  message_id text,
  unique (user_id, email_key)
);

alter table public.nexus_email_log enable row level security;

-- ai_rate_limits + increment_rate_limit: the ai-proxy edge function's
-- per-user and per-IP counters. Only the service role calls this.
create table if not exists public.ai_rate_limits (
  key          text        primary key,
  count        int         not null default 0,
  window_start timestamptz not null default now()
);

alter table public.ai_rate_limits enable row level security;

create or replace function public.increment_rate_limit(
  p_key        text,
  p_window_sec int
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.ai_rate_limits as t (key, count, window_start)
  values (p_key, 1, now())
  on conflict (key) do update
    set
      count = case
        when t.window_start < now() - (p_window_sec || ' seconds')::interval
          then 1
          else t.count + 1
      end,
      window_start = case
        when t.window_start < now() - (p_window_sec || ' seconds')::interval
          then now()
          else t.window_start
      end
  returning t.count into v_count;

  return v_count;
end;
$$;

revoke execute on function public.increment_rate_limit(text, int) from public, anon, authenticated;
grant execute on function public.increment_rate_limit(text, int) to service_role;
