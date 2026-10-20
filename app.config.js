// app.config.js
// Expo reads app.json first and passes it here as `config`. This file fills in
// the values that differ per deployment from environment variables, so no
// project-specific IDs or keys live in the repo. See .env.example.
//
// Every EXPO_PUBLIC_* value is also mirrored into `extra`, because Xcode
// archives do not receive EAS build-profile env vars at bundle time
// (see src/utils/public-config.ts).

const PUBLIC_KEYS = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_AI_PROXY_URL',
  'EXPO_PUBLIC_AI_PROXY_TOKEN',
  'EXPO_PUBLIC_REVENUECAT_API_KEY',
  'EXPO_PUBLIC_POSTHOG_KEY',
  'EXPO_PUBLIC_POSTHOG_HOST',
  'EXPO_PUBLIC_SENTRY_DSN',
  'EXPO_PUBLIC_GOOGLE_SIGNIN_IOS_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_CALENDAR_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_CALENDAR_REDIRECT_URI',
  'EXPO_PUBLIC_MICROSOFT_CALENDAR_CLIENT_ID',
  'EXPO_PUBLIC_MICROSOFT_CALENDAR_REDIRECT_URI',
  'EXPO_PUBLIC_INTERNAL_USER_IDS',
];

// "1234-abc.apps.googleusercontent.com" -> "com.googleusercontent.apps.1234-abc"
function reversedGoogleClientId(clientId) {
  const suffix = '.apps.googleusercontent.com';
  if (!clientId || !clientId.endsWith(suffix)) return null;
  return `com.googleusercontent.apps.${clientId.slice(0, -suffix.length)}`;
}

module.exports = ({ config }) => {
  const extra = { ...(config.extra || {}) };
  for (const key of PUBLIC_KEYS) {
    if (process.env[key]) extra[key] = process.env[key];
  }

  // EAS project ID (from `eas init`). Optional for local development.
  const easProjectId = process.env.EAS_PROJECT_ID;
  if (easProjectId) {
    extra.eas = { ...(extra.eas || {}), projectId: easProjectId };
  }

  // Google Sign-In needs the reversed iOS client ID registered as a URL scheme.
  const ios = { ...(config.ios || {}) };
  const scheme = reversedGoogleClientId(process.env.EXPO_PUBLIC_GOOGLE_SIGNIN_IOS_CLIENT_ID);
  if (scheme && ios.infoPlist && Array.isArray(ios.infoPlist.CFBundleURLTypes)) {
    ios.infoPlist = {
      ...ios.infoPlist,
      CFBundleURLTypes: ios.infoPlist.CFBundleURLTypes.map((t) =>
        String(t.CFBundleURLName || '').endsWith('googleoauth')
          ? { ...t, CFBundleURLSchemes: [scheme] }
          : t,
      ),
    };
  }

  // Bundle ID: override with IOS_BUNDLE_ID when you ship your own build.
  if (process.env.IOS_BUNDLE_ID) ios.bundleIdentifier = process.env.IOS_BUNDLE_ID;

  const next = { ...config, ios, extra };
  if (easProjectId) {
    next.updates = {
      url: `https://u.expo.dev/${easProjectId}`,
      requestHeaders: { 'expo-channel-name': 'production' },
    };
  }
  return next;
};
