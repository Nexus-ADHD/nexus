-- NEX-181: SMS opt-in consent audit trail.
-- NEX-86 recorded WHEN consent happened (opted_in_at/confirmed_at) but not WHICH
-- disclosure text the user agreed to. TCPA/CTIA want a provable "exact text shown
-- at consent time" record, so add a verbatim text column plus a server-validated
-- version id. Both written by the sms-opt-in edge function on `enable`.

alter table public.sms_opt_in
  add column if not exists consent_version text,
  add column if not exists consent_text    text;

comment on column public.sms_opt_in.consent_version is
  'NEX-181: id of the in-app TCPA disclosure the user agreed to at opt-in. Server-validated against an '
  'allowlist in the sms-opt-in edge function (never an arbitrary client string). Maps to '
  'SMS_CONSENT_VERSION in settings-screen.tsx.';
comment on column public.sms_opt_in.consent_text is
  'NEX-181: verbatim disclosure text shown to the user at opt-in (the audit-of-record). Written by the '
  'sms-opt-in edge function on enable. NULL on legacy rows or a client that did not report it.';

-- Mark pre-NEX-181 rows with an explicit legacy sentinel rather than a silent NULL,
-- so a row whose consent text was never captured is distinguishable from a bug.
-- (consent_text stays NULL for these — we did not capture it verbatim at the time.)
update public.sms_opt_in
  set consent_version = 'legacy-nex86-unversioned'
  where consent_version is null;
