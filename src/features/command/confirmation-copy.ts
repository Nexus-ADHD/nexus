/**
 * confirmation-copy.ts
 *
 * NEX-195 (ADHD §1.5 Law A): the location-bearing confirmation copy.
 *
 * After a capture, the confirmation must name WHERE the item now lives in a
 * present-tense, declarative line ("On your Home, under Today.") — never a
 * bare "Saved." This module owns that surface → copy mapping. It is a pure,
 * React-free function so vitest (Node-only) can cover the copy contract,
 * including the §18.1 bans (no em dash, no exclamation point).
 *
 * The ledger composes the per-surface line as the confirmation HEADLINE; the
 * per-item card still shows its own `detail` (e.g. the today-only note).
 */

export type CaptureSurface = 'home_today' | 'inbox' | 'orbit' | 'align' | 'calendar';

/** BUSINESS → Business. Keeps the calm declarative register (§18.2) — an
 *  all-caps category would read as a shout. Falls back gracefully. */
export function titleCaseCategory(category?: string | null): string {
  const c = (category ?? '').trim();
  if (!c) return 'Business';
  return c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
}

/**
 * The present-tense, location-bearing line for a captured item's surface.
 * Returns null for an unknown/absent surface so the caller can fall back to
 * the item's generic detail.
 */
export function locationLine(
  surface: CaptureSurface | undefined,
  opts?: { category?: string | null },
): string | null {
  switch (surface) {
    case 'home_today':
      return 'On your Home, under Today.';
    case 'inbox':
      return 'In your Inbox.';
    case 'orbit':
      return 'On your Orbit schedule.';
    case 'align':
      return `In Align, under ${titleCaseCategory(opts?.category)}.`;
    case 'calendar':
      return 'On your Apple Calendar.';
    default:
      return null;
  }
}
