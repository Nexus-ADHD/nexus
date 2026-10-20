// src/sentry-init.ts — NEX-269
//
// Earliest-possible Sentry initialization. Imported by the custom entry
// (index.js) BEFORE 'expo-router/entry', so Sentry's JS error handler is
// installed before the app modules (app/_layout.tsx and everything it imports)
// evaluate. This captures module-eval / early-launch uncaught throws that would
// otherwise fall through to expo-updates ErrorRecovery as a launch SIGABRT
// (the NEX-269 "crash #2" class).
//
// Scope note: this is JS-layer init only.
//  - A throw inside THIS module's own imports (Sentry, expo-updates,
//    expo-constants, expo-device) still precedes init. The truly-pre-JS window
//    is covered by native-early init (sentry.options.json), which needs the
//    Sentry RN SDK 8.x and is the PR2 follow-on.
//  - Release-bundle SYMBOLICATION (source-map + dSYM upload via the Xcode build
//    phases) is wired in the companion symbolication change
//    (scripts/apply-sentry-ios-buildphases.mjs + eas.json), so release App Hang /
//    crash stacks symbolicate instead of arriving minified.
//
// Consent posture (approved): crash reporting runs from launch, is NOT
// co-gated with the PostHog analytics consent, and sends no PII. See
// docs/automation/crash-telemetry-policy.md.
import * as Sentry from '@sentry/react-native';
import * as Updates from 'expo-updates';
import { publicConfigValue } from './utils/public-config';

// DSN via the EXPO_PUBLIC_* archive-inlining rule: a STATIC process.env access
// (Metro only inlines static member expressions), falling back to app.json
// `extra`. An empty/missing value is treated as missing by publicConfigValue.
const dsn = publicConfigValue('EXPO_PUBLIC_SENTRY_DSN', process.env.EXPO_PUBLIC_SENTRY_DSN);

// Enable only in a non-dev build that has a DSN.
//  - `!__DEV__` already excludes every Metro / dev-client run, including the
//    simulator dev session, so no separate SIM_BYPASS term is needed here —
//    unlike PostHog, whose gate runs in dev and must check SIM_BYPASS. A
//    deliberate Release build (e.g. an on-device smoke test) reports normally.
//  - DSN guard: no DSN -> no init, no throw. Sentry.init must be the most
//    defensive module-eval code in the app — a throw here would itself become
//    the ErrorRecovery launch-crash class this integration exists to eliminate.
const sentryEnabled = !__DEV__ && dsn.length > 0;

if (sentryEnabled) {
  try {
    Sentry.init({
      dsn,
      enabled: true,
      // Symbolication-first: NO performance tracing/profiling. App Hangs are
      // native main-thread events, so the symbolicated native stack (dSYMs,
      // wired in the companion symbolication change) identifies the culprit.
      // On RN SDK 7.2.0 transaction profiling would not reliably profile a hang
      // (no AppHangV2, no continuous/UI profiling) and would add event cost + a
      // PII surface (interaction-transaction names, span URLs), so it stays off.
      tracesSampleRate: 0,
      // iOS App Hang tracking. Both values are already the SDK defaults (that is
      // why hangs are reported today) — set explicitly to document the >=2s
      // policy; PR1's symbolication is what makes these events actionable.
      enableAppHangTracking: true,
      appHangTimeoutInterval: 2, // seconds = the >=2000ms App Hang threshold
      sendDefaultPii: false,
      beforeSend(event) {
        // Belt-and-suspenders: never attach user identity to a crash event.
        // (Note: beforeSend filters JS-layer events only, not native crashes —
        // which is why we also keep sendDefaultPii:false.)
        delete event.user;
        return event;
      },
      beforeBreadcrumb(crumb) {
        // PII hardening (reduces EXISTING surface; never throws). The RN SDK
        // captures console.* as breadcrumbs by default, and this app logs
        // emails / user-ids / auth errors — drop those entirely. For network
        // breadcrumbs, strip BOTH query string and fragment (tokens ride in
        // `#access_token=…` too) and drop any captured request headers.
        try {
          if (crumb.category === 'console') return null;
          if (crumb.data) {
            if (crumb.data.url) {
              crumb.data.url = String(crumb.data.url).split(/[?#]/)[0];
            }
            delete crumb.data.headers;
            delete crumb.data.request_headers;
          }
        } catch {
          // never throw
        }
        return crumb;
      },
    });

    // Tag every event with the expo-updates identity so the "misleading build
    // number / foreign-embedded-update" confusion (LEARNINGS 2026-06-10) is
    // resolvable by filtering on update_id, not the native build number.
    Sentry.setContext('expo_update', {
      updateId: Updates.updateId ?? null,
      channel: Updates.channel ?? null,
      runtimeVersion: Updates.runtimeVersion ?? null,
      isEmbeddedLaunch: Updates.isEmbeddedLaunch ?? null,
      isEmergencyLaunch: Updates.isEmergencyLaunch ?? null,
      emergencyLaunchReason: Updates.emergencyLaunchReason ?? null,
    });
  } catch (e) {
    // Telemetry setup must never crash the app.
    console.error('[Nexus] Sentry init failed:', e);
  }
}

export const isSentryEnabled = sentryEnabled;
