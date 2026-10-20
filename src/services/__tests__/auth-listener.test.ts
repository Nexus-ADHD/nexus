import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferredAuthListener, type AuthTransition } from '../auth-listener';

describe('deferredAuthListener (the onAuthStateChange deadlock, builds 255-257)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns synchronously before the handler has even started', () => {
    const started: string[] = [];
    const listener = deferredAuthListener(async (event: string) => {
      started.push(event);
      await new Promise(() => {}); // a handler that never settles (a cloud restore waiting on the lock)
    });
    const ret = listener('TOKEN_REFRESHED', { user: { id: 'u' } });
    expect(ret).toBeUndefined();
    // auth-js can release its lock now: nothing ran inside the subscriber.
    expect(started).toEqual([]);
    vi.advanceTimersByTime(0);
    expect(started).toEqual(['TOKEN_REFRESHED']);
  });

  it('runs handlers in order and passes event + session through', async () => {
    const seen: [string, unknown][] = [];
    const listener = deferredAuthListener(async (event: string, session: unknown) => {
      seen.push([event, session]);
    });
    listener('SIGNED_IN', 1);
    await vi.advanceTimersByTimeAsync(0);
    listener('SIGNED_OUT', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([['SIGNED_IN', 1], ['SIGNED_OUT', null]]);
  });

  it('a rejecting or throwing handler reaches onError and never auth-js', async () => {
    const errors: unknown[] = [];
    const rejecting = deferredAuthListener(async () => { throw new Error('boom'); }, (e) => errors.push(e));
    const throwing = deferredAuthListener((() => { throw new Error('sync'); }) as any, (e) => errors.push(e));
    expect(() => rejecting('SIGNED_IN', null)).not.toThrow();
    expect(() => throwing('SIGNED_IN', null)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.map((e) => (e as Error).message)).toEqual(['boom', 'sync']);
  });

  it('an older handler suspended across an await sees isCurrent() false once a newer event lands (T-Rex, PR #490)', async () => {
    const writes: string[] = [];
    let releaseRestore: () => void = () => {};
    const listener = deferredAuthListener(async (event: string, _s: unknown, t: AuthTransition) => {
      if (event === 'SIGNED_IN') {
        expect(t.isCurrent()).toBe(true);
        await new Promise<void>((r) => { releaseRestore = r; }); // the cloud restore
        if (!t.isCurrent()) { writes.push('signed-in: stale, skipped'); return; }
        writes.push('signed-in: merged cloud state');
      } else {
        writes.push('signed-out: reset');
      }
    });
    listener('SIGNED_IN', { user: { id: 'A' } });
    await vi.advanceTimersByTimeAsync(0);
    listener('SIGNED_OUT', null);
    await vi.advanceTimersByTimeAsync(0);
    releaseRestore();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['signed-out: reset', 'signed-in: stale, skipped']);
  });

  it('with no newer event the same handler stays current after its await', async () => {
    const writes: string[] = [];
    let release: () => void = () => {};
    const listener = deferredAuthListener(async (_e: string, _s: unknown, t: AuthTransition) => {
      await new Promise<void>((r) => { release = r; });
      writes.push(t.isCurrent() ? 'merged' : 'skipped');
    });
    listener('SIGNED_IN', { user: { id: 'A' } });
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['merged']);
  });
});
