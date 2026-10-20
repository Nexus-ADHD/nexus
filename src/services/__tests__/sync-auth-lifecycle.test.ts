import { describe, expect, it, vi } from 'vitest';
import { createSyncAuthLifecycle, captureSyncAuthTransition } from '../sync-auth-lifecycle';
import { createSyncSessionManager } from '../sync-session';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(localOwner: string | null = null) {
  const sessions = createSyncSessionManager();
  let owner = localOwner;
  let hydrated = true;
  const restore = deferred();
  const deps = {
    waitForHydration: vi.fn(async () => {}),
    hasHydrated: () => hydrated,
    localUserId: () => owner,
    setLocalUserId: vi.fn((uid: string) => { owner = uid; }),
    isDeletionPending: vi.fn(async () => false),
    resetLocal: vi.fn(() => { owner = null; sessions.stop(); }),
    beginSession: vi.fn(sessions.begin),
    stopSession: sessions.stop,
    restore: vi.fn(() => restore.promise),
  };
  return { lifecycle: createSyncAuthLifecycle(deps), deps, sessions, restore, setHydrated: (value: boolean) => { hydrated = value; } };
}

describe('auth sync lifecycle', () => {
  it('a raw signout cancels launch getSession and the old owner before deferred work', async () => {
    const f = fixture();
    f.lifecycle.observe('A');
    const session = await f.lifecycle.prepare('A', () => true);
    const launch = f.lifecycle.capture();
    f.lifecycle.observe(null);
    expect(launch.isCurrent()).toBe(false);
    expect(session?.isCurrent()).toBe(false);
    expect(f.lifecycle.accepts('A')).toBe(false);
    expect(await f.lifecycle.prepare('A', () => true)).toBeNull();
  });

  it('refreshing the same user shares the owner and pending initial restore', async () => {
    const f = fixture();
    f.lifecycle.observe('A');
    const session = (await f.lifecycle.prepare('A', () => true))!;
    const pending = f.lifecycle.restore(session);
    f.lifecycle.observe('A');
    const refreshed = (await f.lifecycle.prepare('A', () => true))!;
    expect(refreshed).toBe(session);
    expect(f.lifecycle.restore(refreshed)).toBe(pending);
    expect(f.deps.restore).toHaveBeenCalledTimes(1);
    f.restore.resolve();
    await pending;
  });

  it('same-user auth events never restart an explicitly stopped deletion session', async () => {
    const f = fixture();
    f.lifecycle.observe('A');
    const session = (await f.lifecycle.prepare('A', () => true))!;
    f.sessions.stop(session);
    f.lifecycle.observe('A');
    expect(await f.lifecycle.prepare('A', () => true)).toBeNull();
    expect(f.deps.beginSession).toHaveBeenCalledTimes(1);
  });

  it('account switch resets only after hydration and cancels earlier pending preparation', async () => {
    const f = fixture('A');
    const disk = deferred();
    f.deps.waitForHydration.mockImplementation(() => disk.promise);
    const turnA = f.lifecycle.observe('A');
    const pendingA = f.lifecycle.prepare('A', turnA.isCurrent);
    f.lifecycle.observe('B');
    const pendingB = f.lifecycle.prepare('B', () => true);
    expect(f.deps.resetLocal).not.toHaveBeenCalled();
    disk.resolve();
    expect(await pendingA).toBeNull();
    expect((await pendingB)?.userId).toBe('B');
    expect(f.deps.resetLocal).toHaveBeenCalledTimes(1);
    expect(f.deps.setLocalUserId).toHaveBeenCalledWith('B');
  });

  it('refuses to start after a hydration timeout; later hydration can retry', async () => {
    const f = fixture();
    f.lifecycle.observe('A');
    f.setHydrated(false);
    expect(await f.lifecycle.prepare('A', () => true)).toBeNull();
    expect(f.deps.beginSession).not.toHaveBeenCalled();
    f.setHydrated(true);
    expect((await f.lifecycle.prepare('A', () => true))?.userId).toBe('A');
  });

  it.each(['sim-dev-user', 'other-account'])('clears known persisted %s data before real sign-in', async (previous) => {
    const f = fixture(previous);
    f.lifecycle.observe('real-account');
    await f.lifecycle.prepare('real-account', () => true);
    expect(f.deps.resetLocal).toHaveBeenCalledTimes(1);
  });

  it('a persisted deletion marker prevents a new process from restoring or uploading', async () => {
    const f = fixture('A');
    f.deps.isDeletionPending.mockResolvedValue(true);
    f.lifecycle.observe('A');
    expect(await f.lifecycle.prepare('A', () => true)).toBeNull();
    expect(f.lifecycle.isDeletionPaused('A')).toBe(true);
    expect(f.deps.beginSession).not.toHaveBeenCalled();
    expect(f.deps.restore).not.toHaveBeenCalled();
    expect(f.deps.resetLocal).not.toHaveBeenCalled();
  });

  it('preserves unknown legacy ownership for conservative reconciliation', async () => {
    const f = fixture(null);
    f.lifecycle.observe('real-account');
    await f.lifecycle.prepare('real-account', () => true);
    expect(f.deps.resetLocal).not.toHaveBeenCalled();
  });

  it('destructive auth guards survive stopping sync but cancel on a new raw auth event', async () => {
    const f = fixture();
    f.lifecycle.observe('A');
    await f.lifecycle.prepare('A', () => true);
    const deletion = captureSyncAuthTransition();
    f.sessions.stop();
    expect(deletion.isCurrent()).toBe(true);
    f.lifecycle.observe('B');
    expect(deletion.isCurrent()).toBe(false);
  });
});
