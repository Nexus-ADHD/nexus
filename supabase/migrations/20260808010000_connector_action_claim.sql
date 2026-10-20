-- Connector actions: RESERVE model for the drain loop (Greptile P1 on PR #392).
--
-- The original apply_connector_action only flipped pending → terminal, so the
-- app had to mutate local state BEFORE claiming the row: a false/error from
-- the RPC (another device won, network blip) left the local apply orphaned and
-- the row pending, so the next drain applied it AGAIN (duplicate inbox tasks,
-- double habit logs). This extends the protocol to the repo's NEX-185
-- reserve → side-effect → finalize pattern:
--
--   pending  → 'claimed'   reserve the row for one device (stamps device_id
--                          and the claim time in applied_at)
--   claimed  → terminal    finalize with the outcome (applied | noop | failed)
--   pending  → terminal    kept for back-compat with the original protocol
--
-- A claim goes stale after 10 minutes: a device that died between claim and
-- finalize must not strand the row forever, so a later drain (same or other
-- device) may reclaim a row whose claim is older than that, and finalize a
-- stale claim it just reclaimed. applied_at doubles as the claim timestamp
-- while status = 'claimed' (no schema change needed).
--
-- SECURITY DEFINER + auth.uid() ownership guard unchanged: a compromised
-- client token can still only transition its own rows along the state machine,
-- never edit payloads.

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
  if p_status not in ('claimed', 'applied', 'noop', 'failed') then
    raise exception 'invalid status %', p_status;
  end if;

  if p_status = 'claimed' then
    -- Reserve. Reclaim is allowed once the prior claim is stale (>10 min) —
    -- the claimant crashed or lost connectivity before finalizing.
    update public.connector_actions
       set status = 'claimed',
           applied_at = now(),          -- claim timestamp while claimed
           applied_by_device_id = p_device_id
     where id = p_action_id
       and user_id = auth.uid()
       and (
         status = 'pending'
         or (status = 'claimed' and applied_at < now() - interval '10 minutes')
       );
    return found;
  end if;

  -- Terminal flip: straight from pending (back-compat) or from a claim this
  -- device holds (or a stale claim it is finalizing after reclaim).
  update public.connector_actions
     set status = p_status,
         outcome = p_outcome,
         applied_at = now(),
         applied_by_device_id = coalesce(p_device_id, applied_by_device_id)
   where id = p_action_id
     and user_id = auth.uid()
     and (
       status = 'pending'
       or (
         status = 'claimed'
         and (
           applied_by_device_id = p_device_id
           or applied_at < now() - interval '10 minutes'
         )
       )
     );
  return found;
end;
$$;

comment on column public.connector_actions.status is
  'pending | claimed | applied | noop | failed — claimed is a device reservation (NEX-185 reserve model), applied_at holds the claim time while claimed';

grant execute on function public.apply_connector_action(uuid, text, text, text)
  to authenticated;
