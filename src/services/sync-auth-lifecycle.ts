import type { SyncSession } from './sync-session';

let authRevision = 0;

// Destructive account work captures this before stopping sync. Raw auth
// changes still cancel it while its own stopped sync token is no longer live.
export function captureSyncAuthTransition() {
  const mine = authRevision;
  return { isCurrent: () => mine === authRevision };
}

interface LifecycleDependencies {
  waitForHydration(): Promise<void>;
  hasHydrated(): boolean;
  localUserId(): string | null;
  setLocalUserId(userId: string): void;
  resetLocal(): void;
  isDeletionPending(userId: string): Promise<boolean>;
  beginSession(userId: string): SyncSession;
  stopSession(session?: SyncSession): void;
  restore(session: SyncSession): Promise<unknown>;
}

/** Owns auth transitions separately from token refreshes and asynchronous restore. */
export function createSyncAuthLifecycle(deps: LifecycleDependencies) {
  let revision = 0;
  let identityRevision = 0;
  let deletionPaused = false;
  let closed = false;
  let userId: string | null | undefined;
  let resetRequired = false;
  let session: SyncSession | null = null;
  let restorePromise: Promise<unknown> | null = null;

  const capture = () => {
    const mine = revision;
    return { isCurrent: () => !closed && revision === mine };
  };

  return {
    capture,
    captureIdentity: () => {
      const mine = identityRevision;
      return { isCurrent: () => !closed && identityRevision === mine };
    },
    isDeletionPaused: (uid: string) => !closed && userId === uid && deletionPaused,
    accepts: (uid: string | null) => !closed && userId === uid,
    // Call in the RAW auth callback, before handing work to the deferred
    // listener. It has no asynchronous work and cannot deadlock GoTrue.
    observe(uid: string | null, discardDevData = false) {
      revision += 1;
      authRevision += 1;
      if (userId !== uid || discardDevData) {
        identityRevision += 1;
        deletionPaused = false;
        resetRequired ||= userId !== undefined || discardDevData;
        deps.stopSession(session ?? undefined);
        session = null;
        restorePromise = null;
        userId = uid;
      }
      return capture();
    },
    async prepare(uid: string, isCurrent: () => boolean): Promise<SyncSession | null> {
      await deps.waitForHydration();
      if (closed || userId !== uid || !isCurrent() || !deps.hasHydrated()) return null;
      const paused = await deps.isDeletionPending(uid);
      if (closed || userId !== uid || !isCurrent()) return null;
      const storedOwner = deps.localUserId();
      const owner = typeof storedOwner === 'string' && storedOwner.length > 0 ? storedOwner : null;
      if (resetRequired || (owner !== null && owner !== uid)) {
        deps.resetLocal();
        resetRequired = false;
      }
      deletionPaused = paused;
      if (paused) {
        deps.stopSession(session ?? undefined);
        deps.setLocalUserId(uid);
        return null;
      }
      if (session) {
        // A stopped same-user session stays stopped. In particular a token
        // refresh must not recreate partially deleted account data.
        return session.isCurrent() ? session : null;
      }
      deps.setLocalUserId(uid);
      session = deps.beginSession(uid);
      return session;
    },
    restore(owner: SyncSession): Promise<unknown> {
      if (closed || owner !== session || !owner.isCurrent()) return Promise.resolve();
      // Launch getSession and INITIAL_SESSION/TOKEN_REFRESHED share restore.
      // The newest deferred handler can release the UI gate when it finishes.
      restorePromise ??= deps.restore(owner);
      return restorePromise;
    },
    dispose() {
      closed = true;
      authRevision += 1;
      revision += 1;
      deps.stopSession(session ?? undefined);
    },
  };
}
