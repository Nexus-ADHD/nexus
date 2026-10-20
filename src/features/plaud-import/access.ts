export const PLAUD_REVIEW_CHANNEL = 'plaud-review';

/**
 * Whether the PLAUD Import row is offered in Settings.
 *
 * Owner-approved 2026-08-15: **available everywhere**, including ordinary
 * production builds. It previously answered `isDev || channel === 'plaud-review'`
 * so the connector could be reviewed on an isolated update channel before its
 * terms were settled.
 *
 * The seam is kept rather than deleted so re-gating is a one-line change: the
 * caller still asks this question, and the arguments are still threaded through
 * `runtime-access.ts`.
 *
 * Note this only controls *discoverability*. Connecting still requires the user
 * to complete PLAUD's own OAuth, and every proposal still passes through the
 * review-and-approve gate before anything reaches the Inbox.
 */
export function isPlaudImportAvailable(_args: {
  isDev: boolean;
  updateChannel: string | null | undefined;
}): boolean {
  return true;
}
