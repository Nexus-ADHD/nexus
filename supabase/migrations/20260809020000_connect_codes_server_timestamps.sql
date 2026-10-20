-- Greptile #405 P1 (round 2): the capped CHECK still bounds expires_at
-- relative to created_at, and BOTH columns are client-writable under the
-- insert-own policy — so a modified client could supply a future created_at
-- with expires_at ten minutes after it and mint a code redeemable years out.
-- CHECK constraints can't call now() (non-immutable), so enforce the
-- server clock with a BEFORE INSERT trigger: created_at is always
-- overwritten with now(), and expires_at is forced into the next ten
-- minutes no matter what the client sent.
--
-- Blast radius is self-only by design (the insert policy pins user_id to
-- auth.uid(), and redemption binds the grant to that same user_id), but the
-- 10-minute window is a real security property — one-time codes must not be
-- extendable by the party holding them.

create or replace function public.connect_codes_force_server_timestamps()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  if new.expires_at is null or new.expires_at > now() + interval '10 minutes' then
    new.expires_at := now() + interval '10 minutes';
  end if;
  return new;
end;
$$;

drop trigger if exists connect_codes_force_server_timestamps on public.connect_codes;
create trigger connect_codes_force_server_timestamps
  before insert on public.connect_codes
  for each row execute function public.connect_codes_force_server_timestamps();
