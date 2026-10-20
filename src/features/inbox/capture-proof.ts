/**
 * capture-proof.ts — NEX-215 (ADHD Pivot P4, I-2)
 *
 * A quiet, verifiable "you captured this" proof line shown under a captured
 * Inbox item's title (caption/mono register). It is PROOF, not a prompt to
 * doubt: an out-of-sight-out-of-mind brain sees the item is really here and
 * when it landed, with no shame and no count-of-absence (§1.5 Law C, §18).
 *
 * Pure logic, no React Native / Expo imports — covered by vitest. Reuses the
 * shared `relativeTime` formatter so the buckets match the rest of the app
 * (sync-status row, etc.) rather than inventing a parallel scale.
 *
 * Gating (deliberately narrow — see the NEX-215 plan review):
 *  - Only MANUAL-source items get a capture line. `source === 'apple_reminders'`
 *    is NOT a reliable "external" proxy: a Reminders-connected manual/voice
 *    capture is stamped `apple_reminders` immediately, AND an imported reminder
 *    is given a sync-time `createdAt` on upsert. So labelling those "Captured …"
 *    would mis-stamp an imported reminder's sync moment as a capture. Those
 *    items already carry their own `↳ Apple Reminders …` provenance line.
 *  - `createdAt` missing / `0` (legacy "unknown" sentinel) / non-finite → null
 *    (render nothing; legacy items stay at the pre-NEX-215 baseline).
 *  - A future `createdAt` (clock skew) is clamped to "just now" by `relativeTime`,
 *    never a negative string.
 *  - Voice provenance is NOT claimed: there is no stored voice flag, so the proof
 *    is the timestamp and the copy stays source-agnostic ("Captured …").
 */
import { relativeTime } from '../../utils/relative-time';

/** Minimal shape the proof line reads from an inbox task. */
export interface CaptureProofInput {
  source?: 'manual' | 'apple_reminders';
  createdAt?: number;
}

/**
 * The capture-proof line for an Inbox row, or `null` when none should render.
 * `now` is injectable for deterministic tests.
 */
export function captureProofLine(task: CaptureProofInput, now: number = Date.now()): string | null {
  // Apple-Reminders items show their own provenance line; never double-stamp,
  // and never label an imported reminder's sync-time as a capture.
  if (task.source === 'apple_reminders') return null;

  const createdAt = task.createdAt;
  // 0 is the legacy "unknown capture time" sentinel; missing/non-finite → no proof.
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }

  // Read "Captured just now" for the whole first minute. `relativeTime` flips to
  // "0m ago" at its 30s threshold (see relative-time.ts — the `< 30_000` line),
  // which reads awkwardly on a proof line the user is looking at right after
  // capturing; this 60s clamp compensates. (If that threshold is ever raised to
  // 60s, this branch becomes redundant — harmless, but the coupling is here.)
  // Also catches a future `createdAt` (negative diff) before delegating.
  if (now - createdAt < 60_000) return 'Captured just now';
  return `Captured ${relativeTime(createdAt, now)}`;
}
