-- NEX-322: allow the 'log_write_failed' attempt phase.
--
-- sms-opt-in now rolls back a pending opt-in when the confirmation's
-- sms_send_log insert fails (that row is what lets a failed-delivery callback
-- expire the attempt — without it the user wedges at pending). The rollback
-- is audited under the new phase 'log_write_failed', which the original
-- NEX-319 check constraint does not allow.

alter table public.sms_send_attempt_log
  drop constraint if exists sms_send_attempt_log_phase_check;

alter table public.sms_send_attempt_log
  add constraint sms_send_attempt_log_phase_check
    check (phase in ('create_failed', 'ambiguous', 'callback_failed', 'log_write_failed'));
