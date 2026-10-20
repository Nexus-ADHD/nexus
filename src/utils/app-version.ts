// src/utils/app-version.ts
// Pure formatter for the Settings "Version" row. Settings used to show a
// hardcoded "1.0.0", so a user reporting their build was reading back a number
// that was never true. Native version + build come from expo-application;
// the OTA update id (expo-updates) distinguishes JS bundles that share a binary.

export function formatAppVersion(version: string | null | undefined, build: string | null | undefined): string {
  const v = (version ?? '').trim();
  const b = (build ?? '').trim();
  if (v && b) return `${v} (${b})`;
  if (v) return v;
  if (b) return `build ${b}`;
  return 'unknown';
}

// Short, readable slice of an OTA update id; null when the app is running the
// embedded bundle (no OTA applied) or in development.
export function formatUpdateId(updateId: string | null | undefined): string | null {
  const id = (updateId ?? '').trim();
  return id ? id.slice(0, 8) : null;
}
