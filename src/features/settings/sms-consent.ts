// NEX-181: SMS TCPA disclosure. Single source of truth for the exact text shown
// AND stored as the consent audit-of-record. Bump SMS_CONSENT_VERSION whenever the
// text changes, AND add the new id to KNOWN_CONSENT_VERSIONS in the sms-opt-in edge
// function. SMS_CONSENT_DISCLOSURE is the full string the user sees (links included);
// it is sent to the server verbatim on opt-in. Legal copy — do not rewrite for voice.
// NEX-323 (v2): daily quotes made the frequency concrete — "up to 2 messages
// per day" replaces the vague "frequency varies". The SMS Terms page
// (nexus-legal/sms) and the Twilio Console keyword replies must say the same.
export const SMS_CONSENT_VERSION = 'nex323-2026-08-03-v2';
export const SMS_CONSENT_BODY =
  'By turning this on, you consent to receive recurring text messages from Nexus, ' +
  'including a morning and evening quote plus occasional content updates and ' +
  'reflections. Message and data rates may apply. Reply STOP to unsubscribe, HELP ' +
  'for help. Up to 2 messages per day. Consent is not a condition of purchase.';
export const SMS_CONSENT_DISCLOSURE = `${SMS_CONSENT_BODY} See our Privacy Policy and Terms.`;
