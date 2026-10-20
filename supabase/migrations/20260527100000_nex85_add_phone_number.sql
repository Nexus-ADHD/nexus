alter table if exists public.user_profile
  add column if not exists phone_number text;

-- NEX-85 follow-up: enforce E.164 format at the DB so client bypasses
-- (direct REST writes, future server-side jobs) can't insert garbage.
-- Pattern: '+' followed by leading non-zero digit + up to 14 more digits.
-- E.164 caps the subscriber portion at 15 digits, so total length
-- including the leading '+' maxes at 16. Allows NULL for users who skipped.
-- Idempotent: guarded so the migration can be re-run safely.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_profile_phone_number_e164_check'
      and conrelid = 'public.user_profile'::regclass
  ) then
    alter table public.user_profile
      add constraint user_profile_phone_number_e164_check
      check (phone_number is null or phone_number ~ '^\+[1-9]\d{1,14}$');
  end if;
end $$;
