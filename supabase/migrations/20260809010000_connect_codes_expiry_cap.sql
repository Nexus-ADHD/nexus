-- Greptile #405 P1: the original CHECK accepted ANY expires_at after
-- created_at, so a modified client could mint a code redeemable far beyond
-- the intended 10-minute window (the DEFAULT only applies when the column
-- is omitted). Cap the lifetime in the constraint itself.

alter table public.connect_codes
  drop constraint if exists connect_codes_expiry_valid;

alter table public.connect_codes
  add constraint connect_codes_expiry_valid
  check (expires_at > created_at and expires_at <= created_at + interval '10 minutes');
