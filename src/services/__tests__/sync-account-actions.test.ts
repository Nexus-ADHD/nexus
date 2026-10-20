import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveBeforeSignOut, stopBeforeAccountDeletion } from '../sync-account-actions';
import { createSyncSessionManager } from '../sync-session';

afterEach(() => vi.useRealTimers());

describe('account sync boundaries', () => {
  it('requires a successful flush and a still-clean current payload before signout', async () => {
    const sessions = createSyncSessionManager();
    const owner = sessions.begin('A');
    expect(await saveBeforeSignOut(owner, async () => {}, () => false)).toBe(true);
    expect(await saveBeforeSignOut(owner, async () => {}, () => true)).toBe(false);
    expect(await saveBeforeSignOut(owner, async () => { throw new Error('offline'); }, () => false)).toBe(false);
    expect(await saveBeforeSignOut(owner, async () => { sessions.stop(); }, () => false)).toBe(false);
  });

  it('times out without stopping the current owner or allowing local reset', async () => {
    vi.useFakeTimers();
    const sessions = createSyncSessionManager();
    const owner = sessions.begin('A');
    const saved = saveBeforeSignOut(owner, () => new Promise(() => {}), () => false, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await saved).toBe(false);
    expect(owner.isCurrent()).toBe(true);
  });

  it('stops synchronously before waiting for already-started writes', async () => {
    const sessions = createSyncSessionManager();
    const owner = sessions.begin('A');
    const settle = vi.fn(async () => { expect(owner.isCurrent()).toBe(false); });
    expect(await stopBeforeAccountDeletion('A', () => sessions.stop(), settle)).toBe(true);
    expect(settle).toHaveBeenCalledWith('A');
  });

  it('a retry still waits for the previous stopped generation after a timeout', async () => {
    vi.useFakeTimers();
    const sessions = createSyncSessionManager();
    const owner = sessions.begin('A');
    let finish!: () => void;
    const writing = new Promise<void>((resolve) => { finish = resolve; });
    sessions.track(owner, writing);
    const first = stopBeforeAccountDeletion('A', () => sessions.stop(), sessions.settleUser, 50);
    expect(owner.isCurrent()).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(await first).toBe(false);
    const second = stopBeforeAccountDeletion('A', () => sessions.stop(), sessions.settleUser, 50);
    let settled = false;
    void second.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toBe(false);
    finish();
    expect(await second).toBe(true);
  });
});
