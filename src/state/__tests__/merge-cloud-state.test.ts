import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppState } from '../app-state';

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

// mergeCloudState fresh-device convergence guards (2026-08-26).
//
// Whole-blob LWW sync can't distinguish "the user cleared this on another
// device" from "a fresh second device's defaults". An EMPTY inbound
// collection merging over a NON-EMPTY local one is how a new iPad's blank
// state erased real data while converging — these guards keep local in that
// case, while non-empty inbound still wins (that IS convergence).

const RICH_LOCAL = {
  inbox: [{ id: 'a', title: 'Real task', source: 'manual', completed: false, status: 'NEW' }],
  dailyTasks: { '2026-08-26': [{ id: 't1', title: 'Ship it' }] },
  scoreHistory: { '2026-08-25': 40 },
  dailyScores: { '2026-08-25': 40 },
  badges: ['first-habit'],
  morningIntention: 'Ship the iPad build',
  morningIntentionDate: '2026-08-26',
  morningIntentionCompletedDate: '2026-08-26',
} as any;

const EMPTY_INBOUND = {
  inbox: [],
  dailyTasks: {},
  scoreHistory: {},
  dailyScores: {},
  badges: [],
  morningIntention: null,
  morningIntentionDate: null,
  morningIntentionCompletedDate: null,
} as any;

describe('mergeCloudState fresh-device guards', () => {
  beforeEach(() => {
    storage.clear();
    useAppState.setState({
      inbox: [],
      dailyTasks: {},
      scoreHistory: {},
      dailyScores: {},
      badges: [],
      morningIntention: null,
      morningIntentionDate: null,
      morningIntentionCompletedDate: null,
    } as any);
  });

  it('keeps non-empty local collections when the inbound blob has them empty', () => {
    useAppState.setState({ ...RICH_LOCAL });
    useAppState.getState().mergeCloudState(EMPTY_INBOUND, { force: true });
    const s = useAppState.getState() as any;
    expect(s.inbox).toHaveLength(1);
    expect(s.dailyTasks['2026-08-26']).toHaveLength(1);
    expect(s.scoreHistory['2026-08-25']).toBe(40);
    expect(s.dailyScores['2026-08-25']).toBe(40);
    expect(s.badges).toEqual(['first-habit']);
    expect(s.morningIntention).toBe('Ship the iPad build');
    expect(s.morningIntentionDate).toBe('2026-08-26');
    expect(s.morningIntentionCompletedDate).toBe('2026-08-26');
  });

  it('applies non-empty inbound collections over local (convergence still wins)', () => {
    useAppState.setState({ ...RICH_LOCAL });
    useAppState.getState().mergeCloudState(
      {
        inbox: [
          { id: 'b', title: 'From phone', source: 'manual', completed: false, status: 'NEW' },
          { id: 'c', title: 'Also from phone', source: 'manual', completed: false, status: 'NEW' },
        ],
        dailyTasks: { '2026-08-26': [{ id: 't9', title: 'Phone task' }] },
        scoreHistory: { '2026-08-26': 55 },
        dailyScores: { '2026-08-26': 55 },
        badges: ['first-habit', 'week-streak'],
        morningIntention: 'Phone intention',
        morningIntentionDate: '2026-08-26',
      },
      { force: true },
    );
    const s = useAppState.getState() as any;
    expect(s.inbox.map((i: any) => i.id)).toEqual(['b', 'c']);
    expect(s.dailyTasks['2026-08-26'][0].id).toBe('t9');
    expect(s.scoreHistory).toEqual({ '2026-08-26': 55 });
    expect(s.dailyScores).toEqual({ '2026-08-26': 55 });
    expect(s.badges).toEqual(['first-habit', 'week-streak']);
    expect(s.morningIntention).toBe('Phone intention');
  });

  it('populates an empty local store from inbound (fresh-install restore unchanged)', () => {
    useAppState.getState().mergeCloudState(
      { inbox: [{ id: 'x', title: 'Restored', source: 'manual', completed: false, status: 'NEW' }] },
      { force: true },
    );
    expect((useAppState.getState() as any).inbox).toHaveLength(1);
  });

  it('still refuses to merge over a populated install without force (NEX-142)', () => {
    useAppState.setState({ ...RICH_LOCAL });
    useAppState.getState().mergeCloudState({ inbox: [{ id: 'b', title: 'x' }] });
    expect((useAppState.getState() as any).inbox[0].id).toBe('a');
  });

  it('unions habitLog by entry id instead of replacing (stale blob cannot erase today)', () => {
    useAppState.setState({
      habitLog: [
        { id: 'today-1', habitTitle: 'meditation', goalIds: [], dateKey: '2026-08-26', timestamp: 2000 },
      ],
    } as any);
    // Inbound is an OLDER snapshot (newer cloud clock, stale contents): it has
    // yesterday's entry but not today's.
    useAppState.getState().mergeCloudState(
      {
        habitLog: [
          { id: 'yesterday-1', habitTitle: 'meditation', goalIds: [], dateKey: '2026-08-25', timestamp: 1000 },
        ],
      },
      { force: true },
    );
    const log = (useAppState.getState() as any).habitLog;
    expect(log.map((e: any) => e.id)).toEqual(['yesterday-1', 'today-1']);
  });
});

describe('mergeCloudState weekly email consent', () => {
  beforeEach(() => {
    useAppState.setState({
      weeklyEmailEnabled: false,
      weeklyEmailConsent: 'unset',
      weeklyEmailConsentUpdatedAt: null,
    } as any);
  });

  it('does not treat a legacy cloud enabled flag as consent', () => {
    useAppState.getState().mergeCloudState({ weeklyEmailEnabled: true }, { force: true });
    const state = useAppState.getState();
    expect(state.weeklyEmailConsent).toBe('unset');
    expect(state.weeklyEmailEnabled).toBe(false);
  });

  it('applies the newer explicit cloud choice', () => {
    useAppState.setState({
      weeklyEmailEnabled: false,
      weeklyEmailConsent: 'denied',
      weeklyEmailConsentUpdatedAt: 10,
    } as any);
    useAppState.getState().mergeCloudState({
      weeklyEmailConsent: 'granted',
      weeklyEmailConsentUpdatedAt: 20,
    }, { force: true });
    const state = useAppState.getState();
    expect(state.weeklyEmailConsent).toBe('granted');
    expect(state.weeklyEmailEnabled).toBe(true);
  });
});


describe('trusted reconciliation and local provenance', () => {
  beforeEach(() => useAppState.getState().resetState());

  it('preserves only this device calendar links while accepting shared rule edits', () => {
    useAppState.setState({ recurringRules: [{ id: 'r1', title: 'Local', appleEventId: 'local-calendar' }] } as any);
    useAppState.getState().mergeCloudState({ recurringRules: [
      { id: 'r1', title: 'Changed on iPad', appleEventId: 'remote-calendar' },
      { id: 'r2', title: 'New', appleEventId: 'another-remote-calendar' },
    ] }, { force: true });
    const rules = useAppState.getState().recurringRules;
    expect(rules[0].title).toBe('Changed on iPad');
    expect(rules[0].appleEventId).toBe('local-calendar');
    expect(rules[1].appleEventId).toBeUndefined();
  });

  it('accepts proven last-item removals and updates derived active rules', () => {
    useAppState.setState({ recurringRules: [{ id: 'r1', title: 'One', excludedFromScore: false }], pinnedHabits: ['r1'], inbox: RICH_LOCAL.inbox, dailyTasks: RICH_LOCAL.dailyTasks } as any);
    useAppState.getState().mergeCloudState({ recurringRules: [], inbox: [], dailyTasks: {} }, {
      force: true, allowEmptyFields: ['recurringRules', 'inbox', 'dailyTasks'],
    });
    const state = useAppState.getState();
    expect(state.recurringRules).toEqual([]);
    expect(state.pinnedHabits).toEqual([]);
    expect(state.inbox).toEqual([]);
    expect(state.dailyTasks).toEqual({});
  });

  it('trusted habit-log undo does not re-union the removed completion', () => {
    useAppState.setState({ habitLog: [{ id: 'removed', timestamp: 1 }] } as any);
    useAppState.getState().mergeCloudState({ habitLog: [] }, { force: true, reconciledHabitLog: true });
    expect(useAppState.getState().habitLog).toEqual([]);
  });

  it('rejects malformed trusted habit-log replacements', () => {
    useAppState.setState({ habitLog: [{ id: 'kept', timestamp: 1 }] } as any);
    useAppState.getState().mergeCloudState({ habitLog: [null, { malformed: true }] }, { force: true, reconciledHabitLog: true });
    expect(useAppState.getState().habitLog.map((entry) => entry.id)).toEqual(['kept']);
  });

  it('does not import cloud ownership and never includes it in the shared payload', async () => {
    const { buildCloudSyncPayload } = await import('../../services/cloud-sync-payload');
    useAppState.setState({ localUserId: 'owner-A' });
    useAppState.getState().mergeCloudState({ localUserId: 'owner-B' }, { force: true });
    expect(useAppState.getState().localUserId).toBe('owner-A');
    expect(buildCloudSyncPayload(useAppState.getState())).not.toHaveProperty('localUserId');
  });

  it('reset invalidates sync before store subscribers can schedule an empty upload', async () => {
    const { beginSyncSession } = await import('../../services/sync-session');
    const session = beginSyncSession('owner-A');
    useAppState.setState({ localUserId: 'owner-A' });
    const states: boolean[] = [];
    const unsubscribe = useAppState.subscribe(() => { states.push(session.isCurrent()); });
    useAppState.getState().resetState();
    unsubscribe();
    expect(states).toEqual([false]);
    expect(useAppState.getState().localUserId).toBeNull();
  });
});
