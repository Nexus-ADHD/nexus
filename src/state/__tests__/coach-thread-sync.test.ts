/**
 * coachThread through the store's persistence, sync, migrate and reset sites
 * (docs/plans/2026-09-02-coach-conversation.md, S1.5, S1.6). Same harness as
 * merge-cloud-state.test.ts: the store is imported with storage + analytics
 * mocked, no RN.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { localStoreHasUserData, useAppState } from '../app-state';
import { PERSIST_VERSION } from '../persistence-keys';
import { buildCloudSyncPayload } from '../../services/cloud-sync-payload';
import { appendMessage, clearThread, emptyCoachThread, markPlanApplying, setPendingPlan, type CoachMessage } from '../../features/coach/coach-thread';

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  },
}));

vi.mock('../../services/analytics', () => ({
  emitHabitLogged: vi.fn(),
  emitTodoCleared: vi.fn(),
  trackEvent: vi.fn(),
}));

const msg = (i: number, at = 1000 + i): CoachMessage => ({ id: `m${i}`, role: i % 2 ? 'coach' : 'user', text: `line ${i}`, at, kind: 'turn' });

function thread(n: number) {
  let t = emptyCoachThread();
  for (let i = 0; i < n; i += 1) t = appendMessage(t, msg(i));
  return t;
}

beforeEach(() => {
  useAppState.getState().resetState();
});

describe('setCoachThread', () => {
  it('applies a reducer atomically and sanitizes on write', () => {
    useAppState.getState().setCoachThread(thread(2));
    useAppState.getState().setCoachThread((t) => appendMessage(t, msg(7)));
    const s = useAppState.getState();
    expect(s.coachThread.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm7']);
    useAppState.getState().setCoachThread({ messages: [{ id: 'x', role: 'alien', text: 1 }], clearedAt: 'no' } as any);
    expect(useAppState.getState().coachThread).toEqual(emptyCoachThread());
  });
});

describe('mergeCloudState (S1.5)', () => {
  it('restores an inbound thread onto an empty install', () => {
    useAppState.getState().mergeCloudState({ coachThread: thread(3) }, { force: true });
    expect(useAppState.getState().coachThread.messages).toHaveLength(3);
  });

  it('keeps the local thread when the inbound one is empty with no tombstone', () => {
    useAppState.getState().setCoachThread(thread(3));
    useAppState.getState().mergeCloudState({ coachThread: emptyCoachThread() }, { force: true });
    expect(useAppState.getState().coachThread.messages).toHaveLength(3);
  });

  it('a newer inbound tombstone clears the local thread', () => {
    useAppState.getState().setCoachThread(thread(3));
    useAppState.getState().mergeCloudState({ coachThread: clearThread(emptyCoachThread(), 9_999) }, { force: true });
    const t = useAppState.getState().coachThread;
    expect(t.messages).toEqual([]);
    expect(t.clearedAt).toBe(9_999);
  });

  it('a locally applying plan survives an inbound plan', () => {
    const plan = { proposalKey: 'k', actions: [{ type: 'inbox_add' as const, title: 'x' }], hasCalendar: false, createdAt: 100, applyingAt: null };
    useAppState.getState().setCoachThread(markPlanApplying(setPendingPlan(thread(1), plan), 150));
    useAppState.getState().mergeCloudState({ coachThread: setPendingPlan(thread(1), { ...plan, proposalKey: 'k2', createdAt: 200 }) }, { force: true });
    expect(useAppState.getState().coachThread.pendingPlan?.proposalKey).toBe('k');
  });
});

describe('resetState + localStoreHasUserData (S1.6)', () => {
  it('sign-out clears the thread', () => {
    useAppState.getState().setCoachThread(thread(2));
    useAppState.getState().resetState();
    expect(useAppState.getState().coachThread).toEqual(emptyCoachThread());
  });

  it('a thread with the person\'s own turn counts as user data; an opener alone does not', () => {
    expect(localStoreHasUserData({ coachThread: emptyCoachThread() })).toBe(false);
    expect(localStoreHasUserData({ coachThread: thread(1) })).toBe(true);
    const openerOnly = appendMessage(emptyCoachThread(), { id: 'o', role: 'coach', text: 'Day is open.', at: 1, kind: 'opener' });
    expect(localStoreHasUserData({ coachThread: openerOnly })).toBe(false);
    const planOnly = setPendingPlan(emptyCoachThread(), { proposalKey: 'k', actions: [{ type: 'inbox_add', title: 'x' }], hasCalendar: false, createdAt: 1, applyingAt: null });
    expect(localStoreHasUserData({ coachThread: planOnly })).toBe(true);
  });
});

describe('persistence (S1.6)', () => {
  it('the outbound payload carries the conversation without the device voice preference', () => {
    const t = thread(2);
    const { speakReplies: _localPreference, ...shared } = t;
    expect(buildCloudSyncPayload({ coachThread: t } as any).coachThread).toEqual(shared);
  });

  it('migrate keeps the thread through a version bump and defaults a missing one', () => {
    const migrate = (useAppState as any).persist.getOptions().migrate as (state: any, version: number) => any;
    const t = thread(2);
    const migrated = migrate({ coachThread: t, recurringRules: [], inbox: [] }, PERSIST_VERSION - 1);
    expect(migrated.coachThread.messages).toHaveLength(2);
    expect(migrated.coachThread.clearedAt).toBeNull();
    const fresh = migrate({ recurringRules: [], inbox: [] }, PERSIST_VERSION - 1);
    expect(fresh.coachThread).toEqual(emptyCoachThread());
  });

  it('migrate never overwrites a persisted speakReplies choice, on an empty, cleared, or spoken-into thread', () => {
    const migrate = (useAppState as any).persist.getOptions().migrate as (state: any, version: number) => any;
    const empty = { ...emptyCoachThread(), speakReplies: false };
    expect(migrate({ coachThread: empty, recurringRules: [], inbox: [] }, PERSIST_VERSION - 1).coachThread.speakReplies).toBe(false);
    const cleared = { ...emptyCoachThread(), clearedAt: 5, speakReplies: false };
    expect(migrate({ coachThread: cleared, recurringRules: [], inbox: [] }, PERSIST_VERSION - 1).coachThread.speakReplies).toBe(false);
    const chosen = { ...thread(2), speakReplies: false };
    expect(migrate({ coachThread: chosen, recurringRules: [], inbox: [] }, PERSIST_VERSION - 1).coachThread.speakReplies).toBe(false);
    expect(migrate({ recurringRules: [], inbox: [] }, PERSIST_VERSION - 1).coachThread.speakReplies).toBe(true);
  });

  it('migrate keeps a pending plan, its applying stamp, and the opener', () => {
    const migrate = (useAppState as any).persist.getOptions().migrate as (state: any, version: number) => any;
    const plan = { proposalKey: 'k', actions: [{ type: 'inbox_add' as const, title: 'x' }], hasCalendar: false, createdAt: 5, applyingAt: 9 };
    const t = { ...setPendingPlan(thread(1), plan), pendingOpener: { text: 'Day is open.', dayKey: '2026-09-02' }, clearedAt: 3 };
    const migrated = migrate({ coachThread: t, recurringRules: [], inbox: [] }, PERSIST_VERSION - 1);
    expect(migrated.coachThread.pendingPlan).toEqual(plan);
    expect(migrated.coachThread.pendingOpener).toEqual({ text: 'Day is open.', dayKey: '2026-09-02', at: 0 });
    expect(migrated.coachThread.clearedAt).toBe(3);
  });
});
