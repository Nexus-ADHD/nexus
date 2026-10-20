-- NEX-321: one LIVE SMS subscription per phone number.
--
-- The blocking prereq for the in-app opt-in ask: sms_opt_in.phone_number was
-- only non-uniquely indexed, and the Twilio webhook updates EVERY row matching
-- an inbound number — so two accounts sharing a phone cross-talk on STOP/YES
-- (one person's STOP silences the other; one YES confirms both).
--
-- The fix is a PARTIAL unique index over live rows only (pending/confirmed),
-- not a full unique constraint, because:
--   * stopped rows are TCPA consent history — a full constraint would force
--     deleting audit rows when a number changes hands;
--   * a number legitimately gets re-registered (new phone owner, new account)
--     after the old subscription stops.
-- At most one live row per phone is exactly the invariant the webhook needs.
--
-- Dedupe FIRST (same caveat as 20260624150000_nex185_sms_send_dedupe_uniq.sql):
-- if duplicates exist the index build fails. Losers are stopped, not deleted,
-- so their consent history survives.

-- ── Step 1: stop duplicate live rows, keeping the most advanced one ─────────
-- Winner per phone: confirmed beats pending, then latest updated_at.
update public.sms_opt_in loser
set opt_in_status = 'stopped',
    stopped_at    = now(),
    updated_at    = now()
where loser.opt_in_status in ('pending', 'confirmed')
  and exists (
    select 1
    from public.sms_opt_in winner
    where winner.phone_number = loser.phone_number
      and winner.opt_in_status in ('pending', 'confirmed')
      and (
        (winner.opt_in_status = 'confirmed' and loser.opt_in_status = 'pending')
        or (
          winner.opt_in_status = loser.opt_in_status
          and (
            winner.updated_at > loser.updated_at
            or (winner.updated_at = loser.updated_at and winner.user_id > loser.user_id)
          )
        )
      )
  );

-- ── Step 2: partial unique index over live rows ─────────────────────────────
create unique index if not exists sms_opt_in_live_phone_uniq
  on public.sms_opt_in (phone_number)
  where opt_in_status in ('pending', 'confirmed');
