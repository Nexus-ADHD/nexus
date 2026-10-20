// src/utils/dev-skip-session.ts
//
// Dev-only "Skip sign-in" session flag. Set when the developer taps
// SKIP SIGN-IN (DEV) on the AuthScreen (real-device dev clients can't
// complete OAuth — the Google/Apple client ids are registered to the
// production bundle id). While active, every network side effect keyed
// on a signed-in session must no-op: cloud sync, weekly/welcome emails,
// and PostHog identify/capture (the fake session runs as SIM_USER_ID,
// which must never reach Supabase or production analytics).
//
// Module-level rather than React state so non-component callers
// (supabase.auth.onAuthStateChange, HomeScreen email effects) can read
// it without prop-drilling or an import cycle through app/_layout.tsx.
// Mirrors the replaySuppressed pattern in src/services/analytics.ts,
// including the typeof guard (bare __DEV__ throws in pure-Node vitest).

let active = false;

export function markDevSkipSession(): void {
  const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
  if (isDev) active = true;
}

export function clearDevSkipSession(): void {
  active = false;
}

export function isDevSkipSessionActive(): boolean {
  return active;
}
