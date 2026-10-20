-- Pre-open-source hardening (2026-10-20). Closes advisor findings 0010/0028/0029.
-- Rate limiter is only called by the ai-proxy edge function with the service role.
revoke execute on function public.increment_rate_limit(text, integer) from public, anon, authenticated;
grant execute on function public.increment_rate_limit(text, integer) to service_role;

-- Trigger function: never meant to be called over the REST API.
revoke execute on function public.fn_apply_nexus_event() from public, anon, authenticated;

-- Connector RPCs are scoped to auth.uid(); signed-in users keep access, signed-out callers lose it.
revoke execute on function public.apply_connector_action(uuid, text, text, text) from public, anon;
grant execute on function public.apply_connector_action(uuid, text, text, text) to authenticated, service_role;
revoke execute on function public.mark_connector_action_local(uuid, text) from public, anon;
grant execute on function public.mark_connector_action_local(uuid, text) to authenticated, service_role;

-- Cross-user activation funnel: internal metrics only, not readable through the public API.
revoke all on public.activation_funnel from anon, authenticated;
alter view public.activation_funnel set (security_invoker = true);
