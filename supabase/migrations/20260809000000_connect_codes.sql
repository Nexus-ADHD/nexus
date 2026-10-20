-- Connect codes: one-time codes that bind a ChatGPT/Claude MCP connection
-- to a specific Nexus account (the multi-user consent door for nexus-mcp).
--
-- The app (Settings → Connect AI) mints an 8-char code, stores only its
-- sha-256 hash here, and shows the plaintext once. The nexus-mcp Worker's
-- consent page redeems a code atomically (single conditional PATCH on
-- used_at IS NULL + expires_at in the future) and binds the OAuth grant to
-- user_id. No passwords cross the worker, so Apple-sign-in users work too.
--
-- RLS: INSERT own only — the app inserts with the user's JWT and never reads
-- back (no SELECT/UPDATE/DELETE policies; the Worker uses the service role,
-- which bypasses RLS). expires_at is a column DEFAULT; the lifetime is
-- enforced by the capped CHECK (20260809010000) plus a BEFORE INSERT trigger
-- (20260809020000) that forces created_at to the server clock, so a modified
-- client cannot mint a long-lived code. used_at is set ONLY by the Worker
-- (service role).

create table if not exists public.connect_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  code_hash   text not null unique, -- sha-256 hex of the uppercase code
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '10 minutes'),
  used_at     timestamptz,
  constraint connect_codes_expiry_valid check (expires_at > created_at)
);

create index if not exists connect_codes_hash_idx
  on public.connect_codes (code_hash);

alter table public.connect_codes enable row level security;

-- Insert-own-only: the app can mint codes for the signed-in user, nothing
-- else. WITH CHECK alone governs INSERT (USING is ignored for inserts).
drop policy if exists connect_codes_insert_own on public.connect_codes;
create policy connect_codes_insert_own on public.connect_codes
  for insert to authenticated
  with check (user_id = auth.uid());
