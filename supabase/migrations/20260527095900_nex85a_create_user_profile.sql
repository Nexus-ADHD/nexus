-- NEX-86 fix (timestamped before NEX-85 on purpose): create public.user_profile.
-- The NEX-85 migration (20260527100000) was written as `alter table if exists`
-- assuming this table already existed — it never did in the remote database,
-- so the migration no-opped and the client's phone-number upsert has been
-- failing silently. This migration creates the table the NEX-85 client code
-- and the NEX-86 sms-opt-in edge function both expect. Ordered before NEX-85
-- so fresh environments replay cleanly: create table → add constraint.

create table if not exists public.user_profile (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  phone_number text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.user_profile enable row level security;

-- The client upserts its own row directly (settings-screen savePhoneNumber),
-- so users need select/insert/update on their own row.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_profile'
      and policyname = 'user_profile_select_own'
  ) then
    create policy user_profile_select_own
      on public.user_profile for select
      using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_profile'
      and policyname = 'user_profile_insert_own'
  ) then
    create policy user_profile_insert_own
      on public.user_profile for insert
      with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_profile'
      and policyname = 'user_profile_update_own'
  ) then
    create policy user_profile_update_own
      on public.user_profile for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;
