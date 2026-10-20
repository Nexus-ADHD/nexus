import { describe, expect, it, vi } from 'vitest';
import { createSyncSessionManager } from '../sync-session';

describe('sync session ownership', () => {
  it('is idempotent for token refresh but invalidates synchronously on user change', () => {
    const manager = createSyncSessionManager();
    const first = manager.begin('one');
    const stopped = vi.fn();
    first.onStop(stopped);
    expect(manager.begin('one')).toBe(first);
    const second = manager.begin('two');
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(stopped).toHaveBeenCalledOnce();
    manager.stop(first);
    expect(second.isCurrent()).toBe(true);
  });

  it('retains in-flight stopped generations across deletion retries', async () => {
    const manager = createSyncSessionManager();
    const session = manager.begin('one');
    let finish!: () => void;
    const write = manager.track(session, new Promise<void>((resolve) => { finish = resolve; }));
    manager.stop();
    expect(manager.get()).toBeNull();
    const settled = vi.fn();
    const wait = manager.settleUser('one').then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    finish();
    await write;
    await wait;
    expect(settled).toHaveBeenCalledOnce();
  });

  it('isolates two device managers and handles removed cleanup callbacks', () => {
    const phone = createSyncSessionManager(), tablet = createSyncSessionManager();
    const p = phone.begin('same'), t = tablet.begin('same');
    const cleanup = vi.fn();
    p.onStop(cleanup)();
    phone.stop();
    expect(cleanup).not.toHaveBeenCalled();
    expect(t.isCurrent()).toBe(true);
  });
});
