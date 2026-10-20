import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the analytics emit so we assert calls without pulling PostHog/supabase deps.
const emitSpy = vi.fn(async (_args: unknown) => {});
vi.mock('../analytics', () => ({ emitCapturedItemFirstReached: (args: unknown) => emitSpy(args) }));

// In-memory AsyncStorage mock.
const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
  },
}));

const KEY = 'nexus_capture_reach_v1';

// Fresh module per test so the module-level map/loadPromise reset.
async function freshModule() {
  vi.resetModules();
  return import('../capture-reach-tracker');
}

beforeEach(() => { store.clear(); emitSpy.mockClear(); });
afterEach(() => { vi.clearAllMocks(); });

describe('recordFirstReach — true-first, exactly-once', () => {
  it('emits once for a known capture, with the access_method', async () => {
    const m = await freshModule();
    await m.recordCapture('A');
    const emitted = await m.recordFirstReach('A', { surface: 'inbox', accessMethod: 'confirmation_jump' });
    expect(emitted).toBe(true);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ captureId: 'A', accessMethod: 'confirmation_jump' }));
  });

  it('no-ops for an unknown id (never recordCapture\'d)', async () => {
    const m = await freshModule();
    const emitted = await m.recordFirstReach('ghost', { surface: 'inbox', accessMethod: 'manual_nav' });
    expect(emitted).toBe(false);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('surfaced-then-manual: first wins, second no-ops', async () => {
    const m = await freshModule();
    await m.recordCapture('A');
    await m.recordFirstReach('A', { surface: 'inbox', accessMethod: 'confirmation_jump' });
    const second = await m.recordFirstReach('A', { surface: 'inbox', accessMethod: 'manual_nav' });
    expect(second).toBe(false);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ accessMethod: 'confirmation_jump' }));
  });

  it('manual-then-surfaced: manual_nav is the recorded first reach', async () => {
    const m = await freshModule();
    await m.recordCapture('A');
    await m.recordFirstReach('A', { surface: 'inbox', accessMethod: 'manual_nav' });
    await m.recordFirstReach('A', { surface: 'inbox', accessMethod: 'home_echo' });
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ accessMethod: 'manual_nav' }));
  });

  it('concurrent double-call emits exactly once', async () => {
    const m = await freshModule();
    await m.recordCapture('A');
    const [a, b] = await Promise.all([
      m.recordFirstReach('A', { surface: 'inbox', accessMethod: 'manual_nav' }),
      m.recordFirstReach('A', { surface: 'inbox', accessMethod: 'manual_nav' }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });
});

describe('lazy-load (NEX-193 race)', () => {
  it('a reach of a prior-session capture (in persisted storage) is not dropped', async () => {
    // Seed storage as if a previous session recorded capture "P" (unreached).
    store.set(KEY, JSON.stringify([['P', false]]));
    const m = await freshModule();
    // First call this session is the reach — the map loads P from storage first.
    const emitted = await m.recordFirstReach('P', { surface: 'inbox', accessMethod: 'manual_nav' });
    expect(emitted).toBe(true);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('a reach already marked reached in a prior session no-ops', async () => {
    store.set(KEY, JSON.stringify([['P', true]]));
    const m = await freshModule();
    const emitted = await m.recordFirstReach('P', { surface: 'inbox', accessMethod: 'manual_nav' });
    expect(emitted).toBe(false);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe('persistence round-trip', () => {
  it('a capture + reach survive a module reload', async () => {
    const m1 = await freshModule();
    await m1.recordCapture('A');
    await m1.recordFirstReach('A', { surface: 'inbox', accessMethod: 'home_echo' });
    // Reload: the persisted reached=true means a re-reach no-ops.
    const m2 = await freshModule();
    const reEmit = await m2.recordFirstReach('A', { surface: 'inbox', accessMethod: 'manual_nav' });
    expect(reEmit).toBe(false);
  });
});

describe('LRU eviction — reached-first, bias-aware', () => {
  it('evicts the oldest REACHED entries before any un-reached, dropping their future reach', async () => {
    const m = await freshModule();
    const CAP = 2000;
    // Oldest 5 are captured AND reached; they should be evicted first on overflow.
    for (let i = 0; i < 5; i++) {
      await m.recordCapture(`r${i}`);
      await m.recordFirstReach(`r${i}`, { surface: 'inbox', accessMethod: 'home_echo' });
    }
    emitSpy.mockClear();
    // Fill with CAP unreached captures → total CAP+5 → 5 evictions.
    for (let i = 0; i < CAP; i++) await m.recordCapture(`u${i}`);

    // The 5 oldest reached are gone: a reach on them is now "unknown" → no emit.
    for (let i = 0; i < 5; i++) {
      const e = await m.recordFirstReach(`r${i}`, { surface: 'inbox', accessMethod: 'manual_nav' });
      expect(e).toBe(false);
    }
    // The oldest un-reached capture survived (hunt-heavy tail preserved).
    const survived = await m.recordFirstReach('u0', { surface: 'inbox', accessMethod: 'manual_nav' });
    expect(survived).toBe(true);
  });
});
