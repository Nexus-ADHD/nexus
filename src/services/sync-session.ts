// Leaf ownership boundary: safe to import from auth, sign-out and the store.
// Invalidating an owner is synchronous; network work already sent is awaited
// separately before destructive account deletion.
export interface SyncSession {
  readonly userId: string;
  readonly generation: number;
  isCurrent(): boolean;
  onStop(cleanup: () => void): () => void;
}

export function createSyncSessionManager() {
  let generation = 0;
  let current: SyncSession | null = null;
  const cleanups = new WeakMap<SyncSession, Set<() => void>>();
  const pending = new Map<SyncSession, Set<Promise<unknown>>>();

  function stop(session: SyncSession | null = current): void {
    if (!session) return;
    if (current === session) current = null;
    const callbacks = cleanups.get(session);
    cleanups.delete(session);
    for (const cleanup of callbacks ?? []) {
      try { cleanup(); } catch { /* one cleanup must not retain other owners */ }
    }
  }

  function begin(userId: string): SyncSession {
    if (!userId) throw new Error('A sync session requires a user');
    if (current?.userId === userId) return current;
    stop();
    const callbacks = new Set<() => void>();
    const session: SyncSession = {
      userId,
      generation: ++generation,
      isCurrent: () => current === session,
      onStop: (cleanup) => {
        if (!session.isCurrent()) { cleanup(); return () => {}; }
        callbacks.add(cleanup);
        return () => { callbacks.delete(cleanup); };
      },
    };
    cleanups.set(session, callbacks);
    current = session;
    return session;
  }

  function track<T>(session: SyncSession, work: Promise<T>): Promise<T> {
    let jobs = pending.get(session);
    if (!jobs) { jobs = new Set(); pending.set(session, jobs); }
    jobs.add(work);
    const done = () => {
      jobs!.delete(work);
      if (jobs!.size === 0) pending.delete(session);
    };
    // Do not leave the rejecting promise returned by finally unobserved.
    void work.then(done, done);
    return work;
  }

  async function settle(session: SyncSession): Promise<void> {
    while (pending.get(session)?.size) await Promise.allSettled([...pending.get(session)!]);
  }

  async function settleUser(userId: string): Promise<void> {
    // Includes stopped generations, so retrying deletion after a timeout
    // cannot forget the write belonging to the previous attempt.
    for (;;) {
      const jobs = [...pending].filter(([session]) => session.userId === userId)
        .flatMap(([, work]) => [...work]);
      if (!jobs.length) return;
      await Promise.allSettled(jobs);
    }
  }

  return {
    begin, stop, track, settle, settleUser,
    get: (userId?: string) => current && (!userId || current.userId === userId) ? current : null,
  };
}

const sessions = createSyncSessionManager();
export const beginSyncSession = sessions.begin;
export const getSyncSession = sessions.get;
export const stopSyncSession = sessions.stop;
export const trackSyncWork = sessions.track;
export const settleSyncSession = sessions.settle;
export const settleSyncSessionsForUser = sessions.settleUser;
