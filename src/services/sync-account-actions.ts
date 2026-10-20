import type { SyncSession } from './sync-session';

async function withinDeadline(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A failed or timed-out save never grants permission to erase pending edits. */
export async function saveBeforeSignOut(
  session: SyncSession,
  flush: (session: SyncSession) => Promise<unknown>,
  hasPendingChanges: (session: SyncSession) => boolean,
  timeoutMs = 6000,
): Promise<boolean> {
  if (!session.isCurrent()) return false;
  const settled = await withinDeadline(flush(session), timeoutMs);
  return settled && session.isCurrent() && !hasPendingChanges(session);
}

/** Stop first; a timeout refuses deletion rather than racing a late writer. */
export async function stopBeforeAccountDeletion(
  userId: string,
  stop: () => void,
  settleAllForUser: (userId: string) => Promise<void>,
  timeoutMs = 6000,
): Promise<boolean> {
  stop();
  return withinDeadline(settleAllForUser(userId), timeoutMs);
}
