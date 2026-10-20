// src/utils/public-config.ts
// Resolves EXPO_PUBLIC_* config with a fallback chain: build-time env first,
// then app.json `extra` (which ships inside every binary via expo-constants).
//
// Why this exists: Xcode archives never receive eas.json build-profile env
// vars, and a missing env var inlines as `undefined` at bundle time. Any
// module-scope code that hard-requires the value (e.g. supabase createClient)
// then throws during bundle evaluation — a launch crash that expo-updates
// ErrorRecovery converts into a SIGABRT before first render. Mirroring every
// EXPO_PUBLIC_* value into app.json `extra` and resolving through this helper
// removes that failure class.
//
// IMPORTANT: callers must pass the env value as a STATIC member expression
// (`process.env.EXPO_PUBLIC_X`), never rely on this helper to look it up.
// Metro only inlines static `process.env.EXPO_PUBLIC_*` accesses; a dynamic
// `process.env[key]` lookup is always undefined in release bundles.
import Constants from 'expo-constants';

export type PublicConfigSource = 'env' | 'extra' | 'missing';

function extraValue(key: string): string {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const value = extra?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

// Note: an empty/whitespace env value is treated as MISSING and falls through
// to extra — so a build profile cannot disable a key by setting it to "".
// If a per-profile kill switch is ever needed, use an explicit sentinel value,
// not an empty string.
export function publicConfigValue(key: string, envValue: string | undefined): string {
  if (typeof envValue === 'string' && envValue.trim()) return envValue.trim();
  return extraValue(key);
}

export function publicConfigSource(key: string, envValue: string | undefined): PublicConfigSource {
  if (typeof envValue === 'string' && envValue.trim()) return 'env';
  if (extraValue(key)) return 'extra';
  return 'missing';
}
