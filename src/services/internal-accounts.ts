// Internal / test account tagging for product analytics.
//
// The founder's own phone produced 86% of PostHog events (2026-10-11 audit), so every
// dashboard was measuring him. We keep sending his events (his usage is the model of
// the ideal customer) but tag them, so the PostHog "Internal / Test users" cohort
// (person property $internal_or_test_user = true) can exclude them everywhere via the
// project's "filter out internal and test users" setting.
//
// Ids come from build config (app.json extra / EXPO_PUBLIC_INTERNAL_USER_IDS), a
// comma-separated list of Supabase user ids. Opaque UUIDs only; no emails.
import { publicConfigValue } from '../utils/public-config';

export function parseInternalIds(raw: string | undefined | null): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

let cached: Set<string> | null = null;

function configuredIds(): Set<string> {
  if (!cached) {
    cached = parseInternalIds(
      publicConfigValue('EXPO_PUBLIC_INTERNAL_USER_IDS', process.env.EXPO_PUBLIC_INTERNAL_USER_IDS),
    );
  }
  return cached;
}

export function isInternalUser(userId: string | null | undefined): boolean {
  if (!userId) return false;
  // Dev builds are always internal (simulator / dev client activity is never a customer).
  if (typeof __DEV__ !== 'undefined' && __DEV__) return true;
  return configuredIds().has(userId.toLowerCase());
}
