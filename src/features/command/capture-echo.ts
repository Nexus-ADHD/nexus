/**
 * capture-echo.ts — NEX-196 (P1.3 voice one-off → Inbox-top + Home echo)
 *
 * After a voice one-off lands at Inbox top, Home shows a small "Just captured.
 * In your Inbox." echo chip so an out-of-sight-out-of-mind brain sees proof of
 * the capture without hunting (§1.5 Law A). Home has no inbox list, only a
 * count pill, so this is the one-off's Home surface.
 *
 * The chip is driven by an ephemeral `justCaptured` ref (app-state.ts,
 * deliberately NON-persisted) plus this pure validity gate.
 *
 * Pure logic, no React Native / Expo imports — covered by vitest.
 */
import type { CaptureSurface } from './confirmation-copy';

/**
 * The ephemeral "just captured" ref that drives the Home echo chip. Session-
 * only; never persisted (see the app-state.ts field comment). `at` is metadata
 * for display/ordering only — it is NOT an expiry gate (no wall-clock TTL).
 */
export interface JustCaptured {
  id: string;
  title: string;
  surface: CaptureSurface;
  at: number;
}

/** Minimal shape of an inbox task the echo gate reads. */
interface InboxLike {
  id: string;
  completed?: boolean;
  status?: string;
}

/**
 * Whether the Home echo chip should render.
 *
 * A VALIDITY gate, not a wall-clock TTL: the chip shows only while the captured
 * one-off still exists in the Inbox and is active. So undo / delete / complete
 * of that item auto-hides the chip with no stale "it's there" pointer
 * (§1.5 Law E), and there is no dismiss timer to leak across a tab unmount.
 */
export function shouldShowCaptureEcho(
  justCaptured: JustCaptured | null | undefined,
  inbox: InboxLike[] | null | undefined,
): boolean {
  if (!justCaptured) return false;
  if (!Array.isArray(inbox)) return false;
  return inbox.some(
    (t) => t?.id === justCaptured.id && t?.status !== 'ARCHIVED' && !t?.completed,
  );
}
