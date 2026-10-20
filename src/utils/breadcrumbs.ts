// src/utils/breadcrumbs.ts
//
// A tiny, never-throwing wrapper around Sentry breadcrumbs used to record what
// the user was doing on the two App-Hang repro paths (Command "tap to speak" and
// Home mount/scroll), so a hang event carries that trail. See
// docs/automation/crash-telemetry-policy.md.
//
// PII rule: NEVER pass user content (voice transcript, captured-item text, names)
// — only states / enums / booleans. Breadcrumbs are a no-op when Sentry is not
// initialized (dev), so call sites need no guard.
import * as Sentry from '@sentry/react-native';

export type AppBreadcrumbCategory = 'command' | 'home' | 'coach';

export function addAppBreadcrumb(
  category: AppBreadcrumbCategory,
  message: string,
  data?: Record<string, string | number | boolean | null>,
): void {
  try {
    Sentry.addBreadcrumb({ category, message, level: 'info', data });
  } catch {
    // Telemetry must never throw.
  }
}
