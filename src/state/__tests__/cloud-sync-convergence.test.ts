import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}),
} }));
vi.mock('../../services/analytics', () => ({ emitHabitLogged: vi.fn(), emitTodoCleared: vi.fn(), trackEvent: vi.fn() }));
import { localStoreHasUserData, useAppState, XP_HABIT_COMPLETE } from '../app-state';
import { buildCloudSyncPayload, normalizeCloudSyncPayload } from '../../services/cloud-sync-payload';
import { createCloudSyncCoordinator } from '../../services/cloud-sync';
import { createSyncSessionManager } from '../../services/sync-session';
import { outboundResult, type CloudSyncBaseline } from '../../services/cloud-sync-guard';
import { appendMessage, emptyCoachThread } from '../../features/coach/coach-thread';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const payload = () => normalizeCloudSyncPayload(buildCloudSyncPayload(useAppState.getState()));
const managers: Array<ReturnType<typeof createSyncSessionManager>> = [];
function harness(base = payload()) {
  let accepted: CloudSyncBaseline = { version: 1, userId: 'owner', updatedAt: '2026-09-12T12:00:00.000Z', payload: clone(base) };
  let row = { state: clone(base), updatedAt: accepted.updatedAt };
  const manager = createSyncSessionManager(); managers.push(manager);
  const session = manager.begin('owner');
  const write = vi.fn(async (_uid, outgoing, options) => {
    if (!options.isCurrent() || options.expectedUpdatedAt !== row.updatedAt) return outboundResult('stale', row.updatedAt);
    row = { state: clone(outgoing), updatedAt: new Date(Date.parse(row.updatedAt) + 1).toISOString() };
    return outboundResult('written', row.updatedAt);
  });
  const sync = createCloudSyncCoordinator({
    getPayload: payload, hasUserData: () => localStoreHasUserData(useAppState.getState()),
    merge: (next, options) => useAppState.getState().mergeCloudState(next, options),
    subscribe: (fn) => useAppState.subscribe(fn),
    load: async () => clone(row), write, track: manager.track, debounceMs: 30, fallbackMs: 10000,
    habitCompletionXP: XP_HABIT_COMPLETE,
    metadata: {
      readBaseline: async () => clone(accepted), readClock: async () => accepted.updatedAt,
      writeBaseline: async (next, current) => { if (!current()) return false; accepted = clone(next); return true; },
      saveRecovery: async (_recovery, current) => current(),
    },
  });
  return { sync, session, write,
    change(patch: Record<string, any>) { row = { state: { ...clone(base), ...clone(patch) }, updatedAt: '2026-09-12T12:00:00.001Z' }; },
  };
}
beforeEach(() => { vi.useFakeTimers(); useAppState.getState().resetState(); });
afterEach(() => { managers.splice(0).forEach((m) => m.stop()); vi.clearAllTimers(); vi.useRealTimers(); });

describe('coordinator with the real persisted app store', () => {
  it('keeps device calendar/voice settings without an inbound echo', async () => {
    useAppState.getState().mergeCloudState({ recurringRules: [
      { id: 'rule', title: 'Run', kind: 'HABIT', frequency: 'daily', excludedFromScore: false },
    ] }, { force: true });
    useAppState.setState({ recurringRules: useAppState.getState().recurringRules.map((r) => ({ ...r, appleEventId: 'phone-event' })) });
    const h = harness();
    h.change({
      recurringRules: useAppState.getState().recurringRules.map((r) => ({ ...r, appleEventId: 'tablet-event' })),
      coachThread: { ...useAppState.getState().coachThread, speakReplies: false },
    });
    await h.sync.restoreFromCloud(h.session); h.sync.startCloudSync(h.session);
    expect(useAppState.getState().recurringRules[0].appleEventId).toBe('phone-event');
    expect(useAppState.getState().coachThread.speakReplies).toBe(true);
    expect(h.sync.hasPendingCloudChanges(h.session)).toBe(false);
    await vi.advanceTimersByTimeAsync(20000);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('propagates a trusted final-item deletion and habit undo without resurrection', async () => {
    useAppState.setState({
      inbox: [{ id: 'task', title: 'Task', completed: false, status: 'NEW', source: 'manual' }],
      habitLog: [{ id: 'done', habitTitle: 'Run', goalIds: [], dateKey: '2026-09-12', timestamp: 1 }],
      totalXP: XP_HABIT_COMPLETE,
    } as any);
    const h = harness();
    h.change({ inbox: [], habitLog: [], totalXP: 0 });
    await h.sync.restoreFromCloud(h.session); h.sync.startCloudSync(h.session);
    expect(useAppState.getState().inbox).toEqual([]);
    expect(useAppState.getState().habitLog).toEqual([]);
    expect(useAppState.getState().totalXP).toBe(0);
    expect(h.sync.hasPendingCloudChanges(h.session)).toBe(false);
    await vi.advanceTimersByTimeAsync(20000);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('saves Coach union and newer local consent once, then becomes quiet', async () => {
    const baseThread = appendMessage(emptyCoachThread(), { id: 'base', role: 'user', text: 'start', at: 1, kind: 'turn' });
    useAppState.getState().setCoachThread(baseThread);
    const h = harness();
    useAppState.getState().setCoachThread(appendMessage(baseThread, { id: 'phone', role: 'user', text: 'phone', at: 2, kind: 'turn' }));
    useAppState.setState({ weeklyEmailConsent: 'granted', weeklyEmailConsentUpdatedAt: Date.parse('2026-09-12T10:00:00.000Z'), weeklyEmailEnabled: true });
    h.change({
      coachThread: appendMessage(baseThread, { id: 'tablet', role: 'user', text: 'tablet', at: 3, kind: 'turn' }),
      weeklyEmailConsent: 'denied', weeklyEmailConsentUpdatedAt: Date.parse('2026-09-11T10:00:00.000Z'), weeklyEmailEnabled: false,
    });
    await h.sync.restoreFromCloud(h.session);
    expect(useAppState.getState().coachThread.messages.map((m) => m.id)).toEqual(['base', 'phone', 'tablet']);
    expect(useAppState.getState().weeklyEmailConsent).toBe('granted');
    expect(h.sync.hasPendingCloudChanges(h.session)).toBe(true);
    await h.sync.flushCloudSync(h.session);
    h.sync.startCloudSync(h.session);
    await vi.advanceTimersByTimeAsync(20000);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.sync.hasPendingCloudChanges(h.session)).toBe(false);
  });
});
