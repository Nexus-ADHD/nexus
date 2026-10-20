/**
 * relativeTime — human-readable "X ago" formatter for the inbox sync
 * status row and similar surfaces. Buckets:
 *   < 30s        → "just now"
 *   < 60m        → "Nm ago"
 *   < 24h        → "Nh ago"
 *   < 48h        → "yesterday"
 *   otherwise    → locale-formatted date (e.g. "5/4/2026")
 *
 * Returns "never" for null timestamps.
 *
 * `now` is injectable (defaults to `Date.now()`) so callers and tests can pin
 * the reference instant deterministically.
 */
export function relativeTime(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms === null || ms === undefined) return 'never';
  const diff = now - ms;
  if (diff < 0) return 'just now'; // future timestamp = clock skew, treat as now
  if (diff < 30_000) return 'just now';
  if (diff < 60 * 60_000) {
    const m = Math.floor(diff / 60_000);
    return `${m}m ago`;
  }
  if (diff < 24 * 60 * 60_000) {
    const h = Math.floor(diff / (60 * 60_000));
    return `${h}h ago`;
  }
  if (diff < 48 * 60 * 60_000) return 'yesterday';
  return new Date(ms).toLocaleDateString();
}
