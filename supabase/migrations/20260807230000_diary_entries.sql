-- Personal AI-coach diary: create public.diary_entries.
-- (No Linear ticket — written as part of the nexus-mcp MCP-server workstream;
-- plain-slug filename is a deliberate deviation from the nexNNN convention.)
--
-- The nexus-mcp Cloudflare Worker (separate repo) is the ONLY writer: Claude.ai
-- / ChatGPT coach sessions call its MCP tools, and it upserts through PostgREST
-- with the service role, keyed on (user_id, entry_date, category, source) so a
-- retried tool call replaces the day's text for that category instead of
-- duplicating it. The iOS app only ever READS this table, hence SELECT-only
-- RLS below (same server-authoritative pattern as sms_send_log).
--
-- category is plain text (no CHECK constraint) so the diary taxonomy can grow
-- without a migration; the Worker validates against the 7 coach categories
-- plus 'session_summary' in zod. source is derived server-side from the OAuth
-- client identity ('claude' | 'chatgpt' | 'unknown').

create table if not exists public.diary_entries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  entry_date   date not null,
  category     text not null,
  content      text not null,
  action_items jsonb,
  source       text not null default 'unknown',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Idempotency key for the Worker's PostgREST upsert
-- (?on_conflict=user_id,entry_date,category,source).
create unique index if not exists diary_entries_dedupe_uniq
  on public.diary_entries (user_id, entry_date, category, source);

alter table public.diary_entries enable row level security;

-- App clients read their own rows only; no insert/update/delete policies —
-- writes happen exclusively through the Worker's service role.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'diary_entries'
      and policyname = 'diary_entries_select_own'
  ) then
    create policy diary_entries_select_own
      on public.diary_entries for select
      using (auth.uid() = user_id);
  end if;
end $$;
