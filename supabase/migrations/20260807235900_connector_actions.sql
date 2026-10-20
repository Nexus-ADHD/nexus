-- Connector actions: server → app write queue for the nexus-mcp MCP server.
-- (No Linear ticket yet — app-side drainer lands in a follow-up PR; plain-slug
-- filename matches the diary_entries precedent.)
--
-- user_state.state_data is device-authoritative whole-blob LWW (devices push
-- every 5 min, never pull on non-empty installs), so external writes to the
-- blob are impossible. Instead, the nexus-mcp Worker (service role) inserts
-- pending actions here, and the app drains them through its real store
-- actions on launch / sync tick, then marks each row via the RPC below.
--
-- RLS: owner SELECT only. Inserts are service-role only (queue_action tool).
-- Status flips go through apply_connector_action — a SECURITY DEFINER RPC —
-- because a plain owner UPDATE policy would let a compromised client token
-- edit payloads/status arbitrarily; the RPC only flips pending → terminal.

create table if not exists public.connector_actions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  action_type text not null,  -- add_inbox_task | log_habit | append_win | add_daily_task
  payload     jsonb not null, -- {title} | {habit_title, date_key?} | {title} | {title, date_key?}
  status      text not null default 'pending',  -- pending | applied | noop | failed
  outcome     text,           -- machine note, e.g. 'already_at_times_per_day'
  created_at  timestamptz not null default now(),
  applied_at  timestamptz,
  applied_by_device_id text
);

-- The drainer polls pending rows for the signed-in user.
create index if not exists connector_actions_pending_idx
  on public.connector_actions (user_id, status, created_at);

alter table public.connector_actions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'connector_actions'
      and policyname = 'connector_actions_select_own'
  ) then
    create policy connector_actions_select_own
      on public.connector_actions for select
      using (auth.uid() = user_id);
  end if;
end $$;

-- Flip one pending action to a terminal state for the calling user.
-- Returns true when the row was actually transitioned (idempotent drain:
-- a second device / retry sees false and skips).
create or replace function public.apply_connector_action(
  p_action_id uuid,
  p_status text,
  p_outcome text default null,
  p_device_id text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('applied', 'noop', 'failed') then
    raise exception 'invalid status %', p_status;
  end if;
  update public.connector_actions
     set status = p_status,
         outcome = p_outcome,
         applied_at = now(),
         applied_by_device_id = p_device_id
   where id = p_action_id
     and user_id = auth.uid()
     and status = 'pending';
  return found;
end;
$$;

revoke all on function public.apply_connector_action(uuid, text, text, text) from public;
grant execute on function public.apply_connector_action(uuid, text, text, text)
  to authenticated;
