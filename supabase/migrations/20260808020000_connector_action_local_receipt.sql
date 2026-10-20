-- Connector actions: server-side local-mutation receipt (Greptile P1 round 4
-- on PR #392).
--
-- The round-3 receipt (AsyncStorage nexus_connector_applied_ids) is
-- per-install: device A applies a non-idempotent action, its finalize RPC
-- fails, the row stays claimed — and once the claim goes stale, device B
-- reclaims and re-applies, duplicating the inbox task / daily task / win.
-- Moving the receipt server-side closes that: any device that reclaims a row
-- can see the mutation already happened and skip straight to finalize.
--
-- local_mutation=true means "some device already ran the store mutation for
-- this row". It is set via mark_connector_action_local — a claimed→claimed
-- transition that also refreshes applied_at, resetting the staleness clock:
-- a device that just proved it's alive (it applied, and is about to finalize)
-- should not have its claim reclaimed mid-finalize.
--
-- SECURITY DEFINER + auth.uid() owner guard, same as apply_connector_action:
-- the RPC only touches rows owned by the caller and only while claimed.

alter table public.connector_actions
  add column if not exists local_mutation boolean not null default false;

comment on column public.connector_actions.local_mutation is
  'true once a device has run the store mutation for this row (set before finalize) — reclaiming devices must skip local apply and only finalize';

create or replace function public.mark_connector_action_local(
  p_action_id uuid,
  p_device_id text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.connector_actions
     set local_mutation = true,
         applied_at = now(),          -- receipt refreshes the staleness clock
         applied_by_device_id = coalesce(p_device_id, applied_by_device_id)
   where id = p_action_id
     and user_id = auth.uid()
     and status = 'claimed';
  return found;
end;
$$;

revoke all on function public.mark_connector_action_local(uuid, text) from public;
grant execute on function public.mark_connector_action_local(uuid, text)
  to authenticated;
