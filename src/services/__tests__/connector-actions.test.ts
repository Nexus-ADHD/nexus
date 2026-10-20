// Unit tests for the connector-actions drain loop (docs/plans/connector-actions.md).
// Pure-Node: AsyncStorage is a Map, supabase is a fake that emulates the
// apply_connector_action RPC's claim state machine (pending → claimed →
// terminal, 10-minute stale-claim reclaim), analytics emitters are no-ops.
// The store under test is the REAL zustand store, so "applies" means the same
// reducers (streaks, XP, badges) as a user tap actually ran.
import { beforeEach, describe, expect, it, vi } from 'vitest';
// vi.mock calls below are hoisted above these imports by vitest, so the store
// and drainer load with the fakes already in place.
import { drainConnectorActions, getConnectorDeviceId } from '../connector-actions';
import { beginSyncSession, stopSyncSession, type SyncSession } from '../sync-session';
import { useAppState, getLocalDateKey, getDayIndexFromDateKey } from '../../state/app-state';

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { storage.delete(key); }),
  },
}));

vi.mock('expo-crypto', () => ({
  randomUUID: vi.fn(() => 'test-device-uuid'),
}));

vi.mock('../analytics', () => ({
  emitHabitLogged: vi.fn(),
  emitTodoCleared: vi.fn(),
  trackEvent: vi.fn(),
}));

const STALE_MS = 10 * 60 * 1000; // mirrors the migration's 10-minute claim guard

const fake = vi.hoisted(() => ({
  rows: [] as any[],
  rpcCalls: [] as any[],
  pushes: [] as any[],
  // Interleaved event log: 'rpc:<status>' | 'receipt' | 'push' — lets tests
  // assert the cross-call ordering (claim → apply → push → receipt → finalize).
  sequence: [] as string[],
  fetchError: null as null | { message: string },
  pushError: false,
  pushStatus: 'written',
  afterFetch: null as null | (() => void),
  afterClaim: null as null | (() => void),
  afterPush: null as null | (() => void),
  afterReceipt: null as null | (() => void),
  // RPC controls, keyed `${actionId}:${p_status}`. FalseFor → { data: false }
  // (lost race / guard refusal), errorsFor → { error } (network/RPC failure).
  // receiptErrorsFor is keyed by bare action id (the mark RPC has no status).
  rpcFalseFor: new Set<string>(),
  rpcErrorsFor: new Set<string>(),
  receiptErrorsFor: new Set<string>(),
}));

vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'connector_actions') throw new Error(`unexpected table ${table}`);
      const filters: Record<string, unknown> = {};
      let staleCutoff: string | null = null;
      let orderBy: { column: string; ascending: boolean } | null = null;
      const result = () => {
        if (fake.fetchError) return { data: null, error: fake.fetchError };
        let rows = fake.rows.filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        // Emulate the drainer's .or(): pending, plus stale un-finalized claims.
        if (staleCutoff) {
          const cutoff = staleCutoff;
          rows = rows.filter(
            (r) =>
              r.status === 'pending' ||
              (r.status === 'claimed' && r.applied_at && r.applied_at < cutoff),
          );
        }
        if (orderBy) {
          const { column, ascending } = orderBy;
          rows = [...rows].sort((a, b) =>
            ascending
              ? String(a[column]).localeCompare(String(b[column]))
              : String(b[column]).localeCompare(String(a[column])),
          );
        }
        fake.afterFetch?.();
        return { data: rows, error: null };
      };
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: unknown) => { filters[col] = val; return builder; },
        or: (expr: string) => {
          const m = /applied_at\.lt\.([^,)]+)/.exec(expr);
          staleCutoff = m ? m[1] : null;
          return builder;
        },
        order: (column: string, opts: { ascending: boolean }) => {
          orderBy = { column, ascending: opts?.ascending !== false };
          return builder;
        },
        then: (onF: any, onR: any) => Promise.resolve(result()).then(onF, onR),
      };
      return builder;
    },
    rpc: async (fn: string, args: any) => {
      fake.rpcCalls.push({ fn, args });
      if (fn === 'mark_connector_action_local') {
        fake.sequence.push('receipt');
        if (fake.receiptErrorsFor.has(args.p_action_id)) {
          return { data: null, error: { message: 'receipt boom' } };
        }
        // claimed → claimed, sets the server-side receipt + freshens the clock.
        const row = fake.rows.find((r) => r.id === args.p_action_id);
        if (!row || row.status !== 'claimed') return { data: false, error: null };
        row.local_mutation = true;
        row.applied_at = new Date().toISOString();
        row.applied_by_device_id = args.p_device_id ?? row.applied_by_device_id;
        fake.afterReceipt?.();
        return { data: true, error: null };
      }
      if (fn !== 'apply_connector_action') return { data: null, error: { message: 'unknown fn' } };
      fake.sequence.push(`rpc:${args.p_status}`);
      const controlKey = `${args.p_action_id}:${args.p_status}`;
      if (fake.rpcErrorsFor.has(controlKey)) return { data: null, error: { message: 'rpc boom' } };
      if (fake.rpcFalseFor.has(controlKey)) return { data: false, error: null };
      // Emulate the migration's state machine: pending → claimed → terminal,
      // pending → terminal back-compat, 10-minute stale-claim reclaim.
      const row = fake.rows.find((r) => r.id === args.p_action_id);
      if (!row) return { data: false, error: null };
      const isStaleClaim =
        row.status === 'claimed' && Date.parse(row.applied_at) < Date.now() - STALE_MS;
      if (args.p_status === 'claimed') {
        if (row.status !== 'pending' && !isStaleClaim) return { data: false, error: null };
        row.status = 'claimed';
        row.applied_at = new Date().toISOString();
        row.applied_by_device_id = args.p_device_id;
        fake.afterClaim?.();
        return { data: true, error: null };
      }
      const canFinalize =
        row.status === 'pending' ||
        (row.status === 'claimed' &&
          (row.applied_by_device_id === args.p_device_id || isStaleClaim));
      if (!canFinalize) return { data: false, error: null };
      row.status = args.p_status;
      row.outcome = args.p_outcome;
      row.applied_at = new Date().toISOString();
      row.applied_by_device_id = args.p_device_id ?? row.applied_by_device_id;
      return { data: true, error: null };
    },
  },
 }));

vi.mock('../cloud-sync', () => ({
  pushCloudSnapshot: async (session: SyncSession, data: any) => {
    fake.sequence.push('push');
    fake.pushes.push({ userId: session.userId, data });
    if (fake.pushError) throw new Error('push boom');
    fake.afterPush?.();
    return { status: fake.pushStatus, deferred: fake.pushStatus !== 'written' };
  },
  requestCloudPull: vi.fn(async () => ({ status: 'unchanged' })),
}));

const USER = 'user-1';
const DEVICE = 'device-1';
let session: SyncSession;

function resetStore() {
  useAppState.setState({
    inbox: [],
    pillars: [],
    habitLog: [],
    habitStreaks: {},
    habitStreakUpdatedDate: {},
    recurringRules: [],
    dailyTasks: {},
    weeklyWins: [],
    weeklyWinsDate: null,
    totalXP: 0,
    badges: [],
    goalHabitMap: {},
    activeChallenge: null,
    completedChallenges: [],
    pendingBadgeUnlock: null,
    pendingBadgeUnlockQueue: [],
    pendingLevelUp: null,
  } as any);
}

function seedRow(partial: Partial<any> & { id: string }) {
  fake.rows.push({
    user_id: USER,
    status: 'pending',
    outcome: null,
    local_mutation: false,
    created_at: '2026-08-07T10:00:00.000Z',
    payload: {},
    ...partial,
  });
}

function daysAgoKey(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return getLocalDateKey(d);
}

const terminalCalls = () =>
  fake.rpcCalls.filter((c) => c.args.p_status !== 'claimed' && c.fn === 'apply_connector_action');

// apply_connector_action statuses only (drops the mark_connector_action_local
// receipt call that sits between claim and finalize).
const applyRpcStatuses = () =>
  fake.rpcCalls
    .filter((c) => c.fn === 'apply_connector_action')
    .map((c) => c.args.p_status);

beforeEach(() => {
  fake.rows = [];
  fake.rpcCalls = [];
  fake.pushes = [];
  fake.sequence = [];
  fake.fetchError = null;
  fake.pushError = false;
  fake.pushStatus = 'written';
  fake.afterFetch = null;
  fake.afterClaim = null;
  fake.afterPush = null;
  fake.afterReceipt = null;
  fake.rpcFalseFor = new Set();
  fake.rpcErrorsFor = new Set();
  fake.receiptErrorsFor = new Set();
  storage.clear();
  resetStore();
  stopSyncSession();
  session = beginSyncSession(USER);
});

describe('drainConnectorActions', () => {
  it('applies add_inbox_task through the store and marks the row applied', async () => {
    seedRow({ id: 'a1', action_type: 'add_inbox_task', payload: { title: 'call the accountant' } });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    const inbox = useAppState.getState().inbox;
    expect(inbox.map((t) => t.title)).toEqual(['call the accountant']);
    expect(fake.rows[0].status).toBe('applied');
    expect(fake.rows[0].applied_by_device_id).toBe(DEVICE);
  });

  it('claims BEFORE applying locally, then finalizes with the outcome', async () => {
    seedRow({ id: 'a1b', action_type: 'add_inbox_task', payload: { title: 'ordered' } });
    await drainConnectorActions(session, DEVICE);
    expect(applyRpcStatuses()).toEqual(['claimed', 'applied']);
  });

  it('applies log_habit for a known habit on the payload date_key, with streak/XP side effects', async () => {
    useAppState.setState({
      recurringRules: [
        { id: 'r1', title: 'Meditate', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timesPerDay: 1 },
      ],
    } as any);
    seedRow({
      id: 'a2',
      action_type: 'log_habit',
      payload: { title: 'Meditate', date_key: '2026-08-06' },
    });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    const s = useAppState.getState();
    expect(s.habitLog).toHaveLength(1);
    expect(s.habitLog[0].habitTitle).toBe('meditate'); // normalized, like a user tap
    expect(s.habitLog[0].dateKey).toBe('2026-08-06'); // NOT hardcoded today
    expect(s.habitStreaks['meditate']).toBe(1);
    expect(s.totalXP).toBeGreaterThan(0);
    expect(fake.rows[0].status).toBe('applied');
  });

  it('accepts the migration comment\'s habit_title payload key too', async () => {
    useAppState.setState({
      recurringRules: [
        { id: 'r1', title: 'Meditate', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timesPerDay: 1 },
      ],
    } as any);
    seedRow({
      id: 'a2b',
      action_type: 'log_habit',
      payload: { habit_title: 'Meditate', date_key: '2026-08-06' },
    });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts.applied).toBe(1);
    expect(useAppState.getState().habitLog).toHaveLength(1);
  });

  it('marks an unknown habit title failed with outcome, without crashing or logging', async () => {
    seedRow({
      id: 'a3',
      action_type: 'log_habit',
      payload: { title: 'No Such Habit', date_key: '2026-08-06' },
    });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 0, noop: 0, failed: 1 });
    expect(fake.rows[0].status).toBe('failed');
    expect(fake.rows[0].outcome).toBe('unknown_habit');
    expect(useAppState.getState().habitLog).toHaveLength(0);
  });

  it('marks a habit already at its timesPerDay cap as noop, not applied', async () => {
    useAppState.setState({
      recurringRules: [
        { id: 'r1', title: 'Meditate', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timesPerDay: 1 },
      ],
      habitLog: [
        { id: 'h1', habitTitle: 'meditate', goalIds: [], dateKey: '2026-08-06', timestamp: 1 },
      ],
    } as any);
    seedRow({
      id: 'a4',
      action_type: 'log_habit',
      payload: { title: 'Meditate', date_key: '2026-08-06' },
    });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 0, noop: 1, failed: 0 });
    expect(fake.rows[0].status).toBe('noop');
    expect(fake.rows[0].outcome).toBe('already_at_times_per_day');
    expect(useAppState.getState().habitLog).toHaveLength(1); // unchanged
  });

  it('appends a win without clobbering existing weeklyWins', async () => {
    const sunday = new Date();
    sunday.setDate(sunday.getDate() - sunday.getDay());
    const sundayKey = getLocalDateKey(sunday);
    useAppState.setState({ weeklyWins: ['shipped the thing'], weeklyWinsDate: sundayKey } as any);
    seedRow({ id: 'a5', action_type: 'append_win', payload: { title: 'closed the loop' } });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(useAppState.getState().weeklyWins).toEqual(['shipped the thing', 'closed the loop']);
    expect(useAppState.getState().weeklyWinsDate).toBe(sundayKey);
  });

  it('applies add_daily_task onto the payload date_key', async () => {
    seedRow({
      id: 'a6',
      action_type: 'add_daily_task',
      payload: { title: 'review budget', date_key: '2026-08-09' },
    });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    const tasks = useAppState.getState().dailyTasks['2026-08-09'] ?? [];
    expect(tasks.map((t) => t.title)).toEqual(['review budget']);
  });

  it('a bad row does not stop the batch: failed row recorded, later rows still apply, order follows created_at', async () => {
    seedRow({ id: 'b3', action_type: 'add_inbox_task', payload: { title: 'third' }, created_at: '2026-08-07T12:00:00.000Z' });
    seedRow({ id: 'b1', action_type: 'mystery_type', payload: { title: 'first' }, created_at: '2026-08-07T09:00:00.000Z' });
    seedRow({ id: 'b2', action_type: 'add_inbox_task', payload: { title: 'second' }, created_at: '2026-08-07T10:00:00.000Z' });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 2, noop: 0, failed: 1 });
    expect(terminalCalls().map((c) => c.args.p_action_id)).toEqual(['b1', 'b2', 'b3']);
    const byId = Object.fromEntries(fake.rows.map((r) => [r.id, r]));
    expect(byId['b1'].status).toBe('failed');
    expect(byId['b1'].outcome).toBe('unknown_action_type');
    expect(byId['b2'].status).toBe('applied');
    expect(byId['b3'].status).toBe('applied');
    expect(useAppState.getState().inbox.map((t) => t.title)).toEqual(['third', 'second']);
  });

  it('re-drain is a no-op: terminal rows are never re-fetched or re-applied', async () => {
    seedRow({ id: 'c1', action_type: 'add_inbox_task', payload: { title: 'once only' } });
    await drainConnectorActions(session, DEVICE);
    expect(fake.rpcCalls).toHaveLength(3); // claim + receipt + finalize
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 0, noop: 0, failed: 0 });
    expect(fake.rpcCalls).toHaveLength(3); // no new RPCs
    expect(useAppState.getState().inbox).toHaveLength(1); // not applied twice
  });

  it('a lost claim race skips the row with NO local apply (the P1 fix)', async () => {
    seedRow({ id: 'd1', action_type: 'add_inbox_task', payload: { title: 'race' } });
    fake.rpcFalseFor.add('d1:claimed'); // another device holds the row
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 0, noop: 0, failed: 0 });
    expect(useAppState.getState().inbox).toHaveLength(0); // nothing applied locally
    expect(terminalCalls()).toHaveLength(0); // and no finalize was attempted
  });

  it('reclaims and applies a claim that went stale (>10 min, another device)', async () => {
    seedRow({
      id: 'd2',
      action_type: 'add_inbox_task',
      payload: { title: 'reclaimed' },
      status: 'claimed',
      applied_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      applied_by_device_id: 'other-device',
    });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(applyRpcStatuses()).toEqual(['claimed', 'applied']);
    expect(useAppState.getState().inbox.map((t) => t.title)).toEqual(['reclaimed']);
    expect(fake.rows[0].applied_by_device_id).toBe(DEVICE);
  });

  it('leaves a fresh claim from another device untouched (not fetched, not drained)', async () => {
    seedRow({
      id: 'd3',
      action_type: 'add_inbox_task',
      payload: { title: 'fresh claim' },
      status: 'claimed',
      applied_at: new Date(Date.now() - 60 * 1000).toISOString(),
      applied_by_device_id: 'other-device',
    });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 0, noop: 0, failed: 0 });
    expect(fake.rpcCalls).toHaveLength(0);
    expect(useAppState.getState().inbox).toHaveLength(0);
    expect(fake.rows[0].status).toBe('claimed');
  });

  it('a finalize failure leaves the row claimed — not lost, not counted, batch continues', async () => {
    seedRow({ id: 'd4', action_type: 'log_habit', payload: { title: 'Nope' } });
    seedRow({ id: 'd5', action_type: 'add_inbox_task', payload: { title: 'still applies' } });
    fake.rpcErrorsFor.add('d4:failed'); // the finalize call for d4 fails
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 }); // d4 uncounted, d5 fine
    const byId = Object.fromEntries(fake.rows.map((r) => [r.id, r]));
    expect(byId['d4'].status).toBe('claimed'); // stranded claim, reclaimable later
    expect(byId['d5'].status).toBe('applied');
  });

  it('drains log_habit actions oldest-date-first while other actions keep created_at order', async () => {
    useAppState.setState({
      recurringRules: [
        { id: 'r1', title: 'Meditate', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timesPerDay: 1 },
      ],
    } as any);
    const day1 = daysAgoKey(1);
    const day2 = daysAgoKey(2);
    // created_at order: newer habit log, inbox task, OLDER habit log.
    seedRow({ id: 'f1', action_type: 'log_habit', payload: { title: 'Meditate', date_key: day1 }, created_at: '2026-08-07T09:00:00.000Z' });
    seedRow({ id: 'f2', action_type: 'add_inbox_task', payload: { title: 'inbox in the middle' }, created_at: '2026-08-07T10:00:00.000Z' });
    seedRow({ id: 'f3', action_type: 'log_habit', payload: { title: 'Meditate', date_key: day2 }, created_at: '2026-08-07T11:00:00.000Z' });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 3, noop: 0, failed: 0 });
    // f3 (older date_key) claims first; f2 keeps its relative slot; f1 last.
    const claimOrder = fake.rpcCalls
      .filter((c) => c.args.p_status === 'claimed')
      .map((c) => c.args.p_action_id);
    expect(claimOrder).toEqual(['f3', 'f2', 'f1']);
    // Both reps landed and the streak grew oldest → newest.
    const s = useAppState.getState();
    expect(s.habitLog.filter((e) => e.habitTitle === 'meditate')).toHaveLength(2);
    expect(s.habitStreaks['meditate']).toBe(2);
    expect(s.habitStreakUpdatedDate['meditate']).toBe(day1);
  });

  it('stamps the server-side local_mutation receipt between apply and finalize', async () => {
    seedRow({ id: 'a1r', action_type: 'add_inbox_task', payload: { title: 'receipt' } });
    await drainConnectorActions(session, DEVICE);
    expect(
      fake.rpcCalls.map((c) =>
        c.fn === 'mark_connector_action_local' ? 'receipt' : c.args.p_status,
      ),
    ).toEqual(['claimed', 'receipt', 'applied']);
    expect(fake.rows[0].local_mutation).toBe(true);
  });

  it('orders apply → push → receipt → finalize, with the mutation inside the pushed blob', async () => {
    seedRow({ id: 's1', action_type: 'add_inbox_task', payload: { title: 'synced task' } });
    await drainConnectorActions(session, DEVICE);
    expect(fake.sequence).toEqual(['rpc:claimed', 'push', 'receipt', 'rpc:applied']);
    expect(fake.pushes).toHaveLength(1);
    expect(fake.pushes[0].data.inbox.map((t: any) => t.title)).toContain('synced task');
  });

  it('push failure: mutated rows stay claimed (no receipt/finalize); re-drain pushes, closes out, no duplicate (round-5 P1)', async () => {
    seedRow({ id: 'p1', action_type: 'add_inbox_task', payload: { title: 'pending sync' } });
    seedRow({ id: 'p2', action_type: 'log_habit', payload: { title: 'Ghost Habit' } });
    fake.pushError = true;
    const first = await drainConnectorActions(session, DEVICE);
    // p2 has no mutation, so it finalizes failed even with the push down;
    // p1 must NOT be receipted or finalized.
    expect(first).toEqual({ applied: 0, noop: 0, failed: 1 });
    const byId1 = Object.fromEntries(fake.rows.map((r) => [r.id, r]));
    expect(byId1['p1'].status).toBe('claimed');
    expect(byId1['p1'].local_mutation).toBe(false);
    expect(byId1['p2'].status).toBe('failed');
    expect(applyRpcStatuses()).toEqual(['claimed', 'claimed', 'failed']);
    expect(useAppState.getState().inbox).toHaveLength(1); // mutation applied locally

    // Recover: the claim goes stale and the push works again.
    fake.pushError = false;
    fake.rows.forEach((r) => {
      if (r.status === 'claimed') {
        r.applied_at = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      }
    });
    fake.sequence = [];
    const second = await drainConnectorActions(session, DEVICE);
    expect(second).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(useAppState.getState().inbox).toHaveLength(1); // NOT duplicated
    // The reclaim retries the missing receipt before finalizing (round-6 gate).
    expect(fake.sequence).toEqual(['rpc:claimed', 'push', 'receipt', 'rpc:applied']);
    const byId2 = Object.fromEntries(fake.rows.map((r) => [r.id, r]));
    expect(byId2['p1'].status).toBe('applied');
    expect(byId2['p1'].outcome).toBe('already_applied_locally');
  });

  it('receipt failure hard-gates finalize: row stays claimed, re-drain retries the receipt, no duplicate (round-6 P1)', async () => {
    seedRow({ id: 'r1', action_type: 'add_inbox_task', payload: { title: 'gate me' } });
    fake.receiptErrorsFor.add('r1');
    fake.rpcErrorsFor.add('r1:applied'); // finalize would ALSO fail — must never be reached
    const first = await drainConnectorActions(session, DEVICE);
    expect(first).toEqual({ applied: 0, noop: 0, failed: 0 });
    expect(fake.rows[0].status).toBe('claimed');
    expect(fake.rows[0].local_mutation).toBe(false);
    expect(applyRpcStatuses()).toEqual(['claimed']); // no finalize attempted
    expect(useAppState.getState().inbox).toHaveLength(1); // mutation landed locally

    // Reclaim with the receipt still failing: the gate stays shut, and the
    // local id set prevents any re-apply.
    fake.rows[0].applied_at = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    fake.sequence = [];
    const second = await drainConnectorActions(session, DEVICE);
    expect(second).toEqual({ applied: 0, noop: 0, failed: 0 });
    expect(fake.sequence).toEqual(['rpc:claimed', 'push', 'receipt']);
    expect(useAppState.getState().inbox).toHaveLength(1);

    // Receipt heals: reclaim pushes, receipts, finalizes — still no duplicate.
    fake.receiptErrorsFor = new Set();
    fake.rpcErrorsFor = new Set();
    fake.rows[0].applied_at = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const third = await drainConnectorActions(session, DEVICE);
    expect(third).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(useAppState.getState().inbox).toHaveLength(1);
    expect(fake.rows[0].status).toBe('applied');
    expect(fake.rows[0].local_mutation).toBe(true);
    expect(fake.rows[0].outcome).toBe('already_applied_locally');
  });

  it('reclaim with failed prior receipt: effect IS in the store → no duplicate, receipt + finalize (round-7 P1)', async () => {
    // Device A applied + synced, but its receipt failed (local_mutation
    // false). This install has no local id; the synced store state already
    // shows the effect (note the case difference — normalize() matching).
    useAppState.setState({
      inbox: [{ id: 'local-1', title: 'Call the Accountant', completed: false, status: 'NEW', createdAt: 1 }],
    } as any);
    seedRow({
      id: 'x1',
      action_type: 'add_inbox_task',
      payload: { title: 'call the accountant' },
      status: 'claimed',
      applied_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      applied_by_device_id: 'device-A',
      local_mutation: false,
    });
    const counts = await drainConnectorActions(session, 'device-B');
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(useAppState.getState().inbox).toHaveLength(1); // NOT duplicated
    expect(fake.sequence).toEqual(['rpc:claimed', 'push', 'receipt', 'rpc:applied']);
    expect(fake.rows[0].status).toBe('applied');
    expect(fake.rows[0].outcome).toBe('already_applied_locally');
    expect(fake.rows[0].local_mutation).toBe(true);
  });

  it('reclaim with failed prior receipt: effect NOT in the store → applies normally', async () => {
    seedRow({
      id: 'x2',
      action_type: 'add_daily_task',
      payload: { title: 'review budget', date_key: '2026-08-09' },
      status: 'claimed',
      applied_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      applied_by_device_id: 'device-A',
      local_mutation: false,
    });
    const counts = await drainConnectorActions(session, 'device-B');
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    const tasks = useAppState.getState().dailyTasks['2026-08-09'] ?? [];
    expect(tasks.map((t) => t.title)).toEqual(['review budget']); // applied
    expect(fake.rows[0].status).toBe('applied');
    expect(fake.rows[0].outcome).toBeNull(); // a real apply, not a dedupe close-out
    expect(fake.rows[0].local_mutation).toBe(true);
  });

  it('reclaim effect detection covers append_win too', async () => {
    const sunday = new Date();
    sunday.setDate(sunday.getDate() - sunday.getDay());
    useAppState.setState({
      weeklyWins: ['closed the loop'],
      weeklyWinsDate: getLocalDateKey(sunday),
    } as any);
    seedRow({
      id: 'x3',
      action_type: 'append_win',
      payload: { title: 'closed the loop' },
      status: 'claimed',
      applied_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      applied_by_device_id: 'device-A',
      local_mutation: false,
    });
    const counts = await drainConnectorActions(session, 'device-B');
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(useAppState.getState().weeklyWins).toEqual(['closed the loop']); // still one
  });

  it('reclaim: local miss applies locally exactly once and pushes, even when a cloud blob carries the effect (round-11/12)', async () => {
    // Device A applied + synced, receipt failed. Round-12 semantics: the cloud
    // blob is no longer consulted at all — the apply decision is the LOCAL
    // fingerprint alone, and a local apply ALWAYS pushes (this device's store
    // is its own push source).
    seedRow({
      id: 'y1',
      action_type: 'add_inbox_task',
      payload: { title: 'call the accountant' },
      status: 'claimed',
      applied_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      applied_by_device_id: 'device-A',
      local_mutation: false,
    });
    const counts = await drainConnectorActions(session, 'device-B');
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    const inbox = useAppState.getState().inbox;
    expect(inbox.map((t) => t.title)).toEqual(['call the accountant']); // exactly once, locally
    expect(fake.sequence).toEqual(['rpc:claimed', 'push', 'receipt', 'rpc:applied']);
    expect(fake.pushes[0].data.inbox.map((t: any) => t.title)).toContain('call the accountant');
    expect(fake.rows[0].status).toBe('applied');
    expect(fake.rows[0].local_mutation).toBe(true);
  });

  it('reclaim: effect absent from the local store → applies normally', async () => {
    seedRow({
      id: 'y3',
      action_type: 'add_inbox_task',
      payload: { title: 'genuinely new' },
      status: 'claimed',
      applied_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      applied_by_device_id: 'device-A',
      local_mutation: false,
    });
    const counts = await drainConnectorActions(session, 'device-B');
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(useAppState.getState().inbox.map((t) => t.title)).toEqual(['genuinely new']);
    expect(fake.sequence).toEqual(['rpc:claimed', 'push', 'receipt', 'rpc:applied']);
    expect(fake.rows[0].outcome).toBeNull(); // a real apply, not a dedupe close-out
  });

  it('reclaim effect detection matches COMPLETED/ARCHIVED inbox items (round-9 P1), with a 30-day recency bound', async () => {
    // Synced by device A, then the user completed it — an open-only
    // fingerprint would miss it and the reclaim would re-add a duplicate.
    useAppState.setState({
      inbox: [
        { id: 'done-1', title: 'call the accountant', completed: true, status: 'ARCHIVED', createdAt: Date.now() },
      ],
    } as any);
    seedRow({
      id: 'x4',
      action_type: 'add_inbox_task',
      payload: { title: 'Call the Accountant' },
      status: 'claimed',
      applied_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      applied_by_device_id: 'device-A',
      local_mutation: false,
    });
    const counts = await drainConnectorActions(session, 'device-B');
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(useAppState.getState().inbox).toHaveLength(1); // NOT re-added
    expect(fake.rows[0].outcome).toBe('already_applied_locally');
  });

  it('reclaim effect detection has NO recency bound: ancient same-title items still dedupe (round-10 P1)', async () => {
    // Applied + synced 60 days ago but never receipted. The reclaim must NOT
    // re-create it — the fingerprint matches regardless of age (it only runs
    // on reclaims, so it can never suppress a fresh user action).
    useAppState.setState({
      inbox: [
        { id: 'old-1', title: 'call the accountant', completed: true, createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000 },
      ],
    } as any);
    seedRow({
      id: 'x5',
      action_type: 'add_inbox_task',
      payload: { title: 'call the accountant' },
      status: 'claimed',
      applied_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      applied_by_device_id: 'device-A',
      local_mutation: false,
    });
    const counts = await drainConnectorActions(session, 'device-B');
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(useAppState.getState().inbox).toHaveLength(1); // NOT re-added
    expect(fake.rows[0].outcome).toBe('already_applied_locally');
  });

  it('reclaim of a PRIOR-WEEK append_win closes as expired, never lands in the wrong week', async () => {
    // weeklyWins keeps one week only — no history to fingerprint against —
    // and appending now would file the win under THIS week. Close it out.
    const threeWeeksAgo = new Date();
    threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);
    const sunday = new Date();
    sunday.setDate(sunday.getDate() - sunday.getDay());
    useAppState.setState({
      weeklyWins: ["this week's win"],
      weeklyWinsDate: getLocalDateKey(sunday),
    } as any);
    seedRow({
      id: 'x6',
      action_type: 'append_win',
      payload: { title: 'an old win' },
      status: 'claimed',
      created_at: threeWeeksAgo.toISOString(),
      applied_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      applied_by_device_id: 'device-A',
      local_mutation: false,
    });
    const counts = await drainConnectorActions(session, 'device-B');
    expect(counts).toEqual({ applied: 0, noop: 1, failed: 0 });
    expect(useAppState.getState().weeklyWins).toEqual(["this week's win"]); // untouched
    expect(fake.rows[0].status).toBe('noop');
    expect(fake.rows[0].outcome).toBe('expired_prior_week');
  });

  it('pins the accepted trade-off: a reclaim matching an existing same-title same-day daily task is suppressed (round-11 P1-2)', async () => {
    // The existing task might be a legitimately separate entry — the
    // fingerprint can't tell — but on the reclaim path a suppressed repeat is
    // the safer failure than a visible double. Fresh rows always apply.
    useAppState.setState({
      dailyTasks: { '2026-08-09': [{ id: 'dt-1', title: 'review budget', completed: false }] },
    } as any);
    seedRow({
      id: 'x7',
      action_type: 'add_daily_task',
      payload: { title: 'Review Budget', date_key: '2026-08-09' }, // case differs — normalize()
      status: 'claimed',
      applied_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      applied_by_device_id: 'device-A',
      local_mutation: false,
    });
    const counts = await drainConnectorActions(session, 'device-B');
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(useAppState.getState().dailyTasks['2026-08-09']).toHaveLength(1); // suppressed, no double
    expect(fake.rows[0].outcome).toBe('already_applied_locally');
    expect(fake.rows[0].local_mutation).toBe(true);
  });

  it('receipted reclaim on a device LACKING the effect applies it once, pushes, finalizes (round-12 P1)', async () => {
    // Device A claimed, applied, pushed, and receipted the row, then its
    // finalize failed. This device's local store never got the effect —
    // skipping the apply here would let this device's next whole-blob push
    // erase the effect everywhere. The local fingerprint (absent) drives the
    // apply; the existing receipt just means no re-stamp is needed.
    seedRow({
      id: 'h1',
      action_type: 'add_inbox_task',
      payload: { title: 'applied on device A' },
      status: 'claimed',
      applied_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      applied_by_device_id: 'device-A',
      local_mutation: true,
    });
    const counts = await drainConnectorActions(session, 'device-B');
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    const inbox = useAppState.getState().inbox;
    expect(inbox.map((t) => t.title)).toEqual(['applied on device A']); // converged locally, once
    // Applied locally → pushes; already receipted → no re-stamp.
    expect(fake.sequence).toEqual(['rpc:claimed', 'push', 'rpc:applied']);
    expect(fake.pushes[0].data.inbox.map((t: any) => t.title)).toContain('applied on device A');
    expect(fake.rows[0].status).toBe('applied');
  });

  it('a stale-claim reclaim closes the row out WITHOUT repeating the local mutation (round-3 P1)', async () => {
    seedRow({ id: 'g1', action_type: 'add_inbox_task', payload: { title: 'inbox once' } });
    seedRow({ id: 'g2', action_type: 'add_daily_task', payload: { title: 'daily once', date_key: '2026-08-09' } });
    seedRow({ id: 'g3', action_type: 'append_win', payload: { title: 'win once' } });
    // First drain: all three finalizes fail AFTER the local mutations landed.
    fake.rpcErrorsFor.add('g1:applied');
    fake.rpcErrorsFor.add('g2:applied');
    fake.rpcErrorsFor.add('g3:applied');
    const first = await drainConnectorActions(session, DEVICE);
    expect(first).toEqual({ applied: 0, noop: 0, failed: 0 });
    expect(useAppState.getState().inbox).toHaveLength(1);
    expect(fake.rows.every((r) => r.status === 'claimed')).toBe(true);

    // Claims go stale; next drain reclaims. The store already carries the
    // effects, so the local fingerprint makes the reclaim skip applyOne and
    // only finalize.
    fake.rows.forEach((r) => {
      r.applied_at = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    });
    fake.rpcErrorsFor = new Set();
    const second = await drainConnectorActions(session, DEVICE);
    expect(second).toEqual({ applied: 3, noop: 0, failed: 0 });
    const s = useAppState.getState();
    expect(s.inbox).toHaveLength(1); // NOT duplicated
    expect(s.dailyTasks['2026-08-09']).toHaveLength(1);
    expect(s.weeklyWins).toEqual(['win once']);
    expect(fake.rows.every((r) => r.status === 'applied')).toBe(true);
    expect(fake.rows.every((r) => r.outcome === 'already_applied_locally')).toBe(true);
  });

  it('survives a fetch error: resolves with zero counts, no throw', async () => {
    fake.fetchError = { message: 'network down' };
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 0, noop: 0, failed: 0 });
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('drains nothing for a different user (rows are filtered by user_id)', async () => {
    seedRow({ id: 'e1', action_type: 'add_inbox_task', payload: { title: 'not yours' } });
    const counts = await drainConnectorActions(beginSyncSession('someone-else'), DEVICE);
    expect(counts).toEqual({ applied: 0, noop: 0, failed: 0 });
    expect(useAppState.getState().inbox).toHaveLength(0);
  });
});

// P1-2: a historical log must be judged by the calendar of its TARGET date,
// not by today. These call the store action directly (the drain path is
// covered above); yesterday always has a different weekday than today, and
// 7 days ago always falls in the previous week.
describe('logHabitForDate target-date calendar context', () => {
  it('awards all_in per the TARGET date\'s schedule, not today\'s', async () => {
    const yesterday = daysAgoKey(1);
    const yesterdayDow = getDayIndexFromDateKey(yesterday);
    const todayDow = new Date().getDay();
    useAppState.setState({
      recurringRules: [
        // Only the target date's schedule is complete after logging A.
        { id: 'ra', title: 'Meditate', daysOfWeek: [yesterdayDow], timesPerDay: 1 },
        // Scheduled today but NOT yesterday — under the old now-based
        // calendar this rule wrongly blocked/qualified all_in.
        { id: 'rb', title: 'Read', daysOfWeek: [todayDow], timesPerDay: 1 },
      ],
      badges: [{ id: 'all_in' }],
    } as any);
    const result = useAppState.getState().logHabitForDate('Meditate', yesterday);
    expect(result).toBe('applied');
    const badge = useAppState.getState().badges.find((b) => b.id === 'all_in');
    expect(badge?.unlockedAt).toBeTruthy();
  });

  it('does NOT award all_in when the target date had no scheduled rules', async () => {
    const yesterday = daysAgoKey(1);
    const todayDow = new Date().getDay();
    useAppState.setState({
      recurringRules: [
        // Scheduled today only; yesterday had nothing scheduled, so the
        // target-date rule set is empty and all_in must not fire.
        { id: 'rb', title: 'Read', daysOfWeek: [todayDow], timesPerDay: 1 },
      ],
      badges: [{ id: 'all_in' }],
    } as any);
    const result = useAppState.getState().logHabitForDate('Read', yesterday);
    expect(result).toBe('applied');
    const badge = useAppState.getState().badges.find((b) => b.id === 'all_in');
    expect(badge?.unlockedAt).toBeFalsy();
  });

  it('counts triple_threat inside the TARGET week, not the current one', async () => {
    const lastWeek = daysAgoKey(7); // previous week, guaranteed
    useAppState.setState({
      recurringRules: [
        { id: 'r1', title: 'Meditate', daysOfWeek: [], timesPerDay: 1 },
        { id: 'r2', title: 'Read', daysOfWeek: [], timesPerDay: 1 },
        { id: 'r3', title: 'Stretch', daysOfWeek: [], timesPerDay: 1 },
      ],
      badges: [{ id: 'triple_threat' }],
    } as any);
    for (const title of ['Meditate', 'Read', 'Stretch']) {
      expect(useAppState.getState().logHabitForDate(title, lastWeek)).toBe('applied');
    }
    const badge = useAppState.getState().badges.find((b) => b.id === 'triple_threat');
    expect(badge?.unlockedAt).toBeTruthy();
  });

  it('backfill logs earn no time-of-day credit (early_bird / early_log); same-day logs do (round-9 P1)', async () => {
    const fakeNow = new Date();
    fakeNow.setHours(6, 30, 0, 0); // inside both early windows (< 7 AM, < 9 AM)
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);
    try {
      const todayKey = getLocalDateKey(new Date());
      const yesterdayKey = daysAgoKey(1);
      const base = () => ({
        recurringRules: [
          { id: 'r1', title: 'Meditate', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timesPerDay: 1 },
        ],
        badges: [{ id: 'early_bird' }],
        activeChallenge: { id: 'ch1', type: 'early_log', progress: 0, target: 2, xpReward: 50, completed: false },
      });

      // Same-day log at 06:30: early credit fires as before.
      resetStore();
      useAppState.setState(base() as any);
      expect(useAppState.getState().logHabitForDate('Meditate', todayKey)).toBe('applied');
      let s = useAppState.getState();
      expect(s.badges.find((b) => b.id === 'early_bird')?.unlockedAt).toBeTruthy();
      expect(s.activeChallenge?.progress).toBe(1);

      // Backfill drained at 06:30: the rep records, but no early credit —
      // a log for yesterday says nothing about when it happened.
      resetStore();
      useAppState.setState(base() as any);
      expect(useAppState.getState().logHabitForDate('Meditate', yesterdayKey)).toBe('applied');
      s = useAppState.getState();
      expect(s.habitLog).toHaveLength(1);
      expect(s.badges.find((b) => b.id === 'early_bird')?.unlockedAt).toBeFalsy();
      expect(s.activeChallenge?.progress).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Greptile #392 round 2: drain order need not match payload date_keys, so a
// backdated completion must never shorten the streak a newer log established.
describe('logHabitForDate backdated completions (streak guard)', () => {
  it('a backfill after a newer completion records the rep but keeps streak and anchor', async () => {
    const day1 = daysAgoKey(1);
    const day2 = daysAgoKey(2);
    const day5 = daysAgoKey(5);
    useAppState.setState({
      recurringRules: [
        { id: 'r1', title: 'Meditate', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timesPerDay: 1 },
      ],
    } as any);
    const store = () => useAppState.getState();
    expect(store().logHabitForDate('Meditate', day2)).toBe('applied');
    expect(store().logHabitForDate('Meditate', day1)).toBe('applied');
    expect(store().habitStreaks['meditate']).toBe(2);
    expect(store().habitStreakUpdatedDate['meditate']).toBe(day1);

    // The backfill: older than the current anchor. Old behavior reset the
    // streak to 1 and rewound the anchor to day5.
    expect(store().logHabitForDate('Meditate', day5)).toBe('applied');
    const s = store();
    expect(s.habitLog.filter((e) => e.habitTitle === 'meditate')).toHaveLength(3); // rep recorded
    expect(s.habitStreaks['meditate']).toBe(2); // streak preserved
    expect(s.habitStreakUpdatedDate['meditate']).toBe(day1); // anchor not rewound
  });
});

describe('mandate actions', () => {
  it('applies add_mandate with category and notes through the real store actions', async () => {
    seedRow({
      id: 'm1',
      action_type: 'add_mandate',
      payload: { title: 'Protect my mornings', category: 'personal', notes: 'Energy is highest before noon' },
    });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    const pillars = useAppState.getState().pillars;
    expect(pillars).toHaveLength(1);
    expect(pillars[0].title).toBe('Protect my mornings');
    expect(pillars[0].category).toBe('PERSONAL'); // addPillarManual uppercases
    expect(pillars[0].notes).toBe('Energy is highest before noon');
    expect(fake.rows[0].status).toBe('applied');
  });

  it('add_mandate defaults the category and tolerates missing notes', async () => {
    seedRow({ id: 'm2', action_type: 'add_mandate', payload: { title: 'Ship Nexus' } });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    const p = useAppState.getState().pillars[0];
    expect(p.category).toBe('BUSINESS');
    expect(p.notes).toBeUndefined();
  });

  it('marks add_mandate without a title failed, no store mutation', async () => {
    seedRow({ id: 'm3', action_type: 'add_mandate', payload: {} });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 0, noop: 0, failed: 1 });
    expect(useAppState.getState().pillars).toHaveLength(0);
    expect(fake.rows[0].outcome).toBe('missing_title');
  });

  it('remove_mandate deletes by normalized title and runs deletePillar link cleanup', async () => {
    useAppState.setState({
      pillars: [{ id: 'p1', title: 'Build Wealth', type: 'ACTION', category: 'BUSINESS' }],
      goalHabitMap: { habitA: ['p1', 'p2'] },
    } as any);
    seedRow({ id: 'm4', action_type: 'remove_mandate', payload: { title: 'build  wealth' } });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    const s = useAppState.getState();
    expect(s.pillars).toHaveLength(0);
    expect(s.goalHabitMap.habitA).toEqual(['p2']); // dead id scrubbed
    expect(fake.rows[0].status).toBe('applied');
  });

  it('remove_mandate with no matching mandate is a noop, not a failure', async () => {
    useAppState.setState({
      pillars: [{ id: 'p1', title: 'Build Wealth', type: 'ACTION' }],
    } as any);
    seedRow({ id: 'm5', action_type: 'remove_mandate', payload: { title: 'Nonexistent' } });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 0, noop: 1, failed: 0 });
    expect(useAppState.getState().pillars).toHaveLength(1); // untouched
    expect(fake.rows[0].outcome).toBe('no_matching_mandate');
  });

  it('remove_mandate matches emoji-decorated titles (Greptile #403 P1)', async () => {
    useAppState.setState({
      pillars: [{ id: 'p1', title: '📌 Build Wealth', type: 'ACTION', category: 'BUSINESS' }],
      goalHabitMap: { habitA: ['p1'] },
    } as any);
    seedRow({ id: 'm8', action_type: 'remove_mandate', payload: { title: 'Build Wealth' } });
    const counts = await drainConnectorActions(session, DEVICE);
    expect(counts).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(useAppState.getState().pillars).toHaveLength(0);
    expect(useAppState.getState().goalHabitMap.habitA).toEqual([]);
  });

  it('reclaim fingerprints agree with emoji-decorated titles: applied removal closes out, no error', async () => {
    useAppState.setState({
      pillars: [{ id: 'p1', title: '📌 Build Wealth', type: 'ACTION' }],
    } as any);
    seedRow({ id: 'm9', action_type: 'remove_mandate', payload: { title: 'Build Wealth' } });
    fake.rpcErrorsFor.add('m9:applied');
    await drainConnectorActions(session, DEVICE);
    expect(useAppState.getState().pillars).toHaveLength(0);

    fake.rows[0].applied_at = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    fake.rpcErrorsFor = new Set();
    const second = await drainConnectorActions(session, DEVICE);
    expect(second).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(fake.rows[0].outcome).toBe('already_applied_locally');
  });

  it('reclaim of an applied add_mandate does NOT duplicate the pillar', async () => {
    seedRow({ id: 'm6', action_type: 'add_mandate', payload: { title: 'Protect my mornings' } });
    fake.rpcErrorsFor.add('m6:applied'); // finalize fails after the mutation
    const first = await drainConnectorActions(session, DEVICE);
    expect(first).toEqual({ applied: 0, noop: 0, failed: 0 });
    expect(useAppState.getState().pillars).toHaveLength(1);

    fake.rows[0].applied_at = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    fake.rpcErrorsFor = new Set();
    const second = await drainConnectorActions(session, DEVICE);
    expect(second).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(useAppState.getState().pillars).toHaveLength(1); // fingerprint hit, no double
    expect(fake.rows[0].outcome).toBe('already_applied_locally');
  });

  it('reclaim of an applied remove_mandate does NOT error when the mandate is already gone', async () => {
    useAppState.setState({
      pillars: [{ id: 'p1', title: 'Build Wealth', type: 'ACTION' }],
    } as any);
    seedRow({ id: 'm7', action_type: 'remove_mandate', payload: { title: 'Build Wealth' } });
    fake.rpcErrorsFor.add('m7:applied');
    const first = await drainConnectorActions(session, DEVICE);
    expect(first).toEqual({ applied: 0, noop: 0, failed: 0 });
    expect(useAppState.getState().pillars).toHaveLength(0); // deleted, not finalized

    fake.rows[0].applied_at = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    fake.rpcErrorsFor = new Set();
    const second = await drainConnectorActions(session, DEVICE);
    // The removal's effect (absence) is present locally → close out, no re-apply.
    expect(second).toEqual({ applied: 1, noop: 0, failed: 0 });
    expect(useAppState.getState().pillars).toHaveLength(0);
    expect(fake.rows[0].outcome).toBe('already_applied_locally');
  });
});

describe('getConnectorDeviceId', () => {
  it('mints once, then returns the persisted install-scoped id', async () => {
    const first = await getConnectorDeviceId();
    expect(first).toBe('test-device-uuid');
    expect(storage.get('nexus_connector_device_id')).toBe('test-device-uuid');
    const second = await getConnectorDeviceId();
    expect(second).toBe(first);
  });
});


describe('connector drain session ownership', () => {
  it.each(['afterFetch', 'afterClaim'] as const)('cannot apply account A rows after signout during %s', async (boundary) => {
    seedRow({ id: `cancel-${boundary}`, action_type: 'add_inbox_task', payload: { title: 'Account A task' } });
    fake[boundary] = () => {
      stopSyncSession(session);
      useAppState.setState({ inbox: [{ id: 'b', title: 'Account B task' }] } as any);
      beginSyncSession('user-b');
    };
    expect(await drainConnectorActions(session, DEVICE)).toEqual({ applied: 0, noop: 0, failed: 0 });
    expect(useAppState.getState().inbox.map((task) => task.title)).toEqual(['Account B task']);
    expect(fake.pushes).toHaveLength(0);
    expect(terminalCalls()).toHaveLength(0);
  });

  it('a write that completes after signout cannot receipt or finalize', async () => {
    seedRow({ id: 'cancel-push', action_type: 'add_inbox_task', payload: { title: 'Pending' } });
    fake.afterPush = () => stopSyncSession(session);
    await drainConnectorActions(session, DEVICE);
    expect(fake.sequence).toEqual(['rpc:claimed', 'push']);
    expect(fake.rows[0].status).toBe('claimed');
  });

  it('a receipt that completes after signout cannot finalize', async () => {
    seedRow({ id: 'cancel-receipt', action_type: 'add_inbox_task', payload: { title: 'Pending' } });
    fake.afterReceipt = () => stopSyncSession(session);
    await drainConnectorActions(session, DEVICE);
    expect(fake.sequence).toEqual(['rpc:claimed', 'push', 'receipt']);
    expect(fake.rows[0].status).toBe('claimed');
  });

  it.each(['stale', 'unknown', 'canceled', 'unchanged'])('keeps rows pending without an exact written acknowledgement (%s)', async (status) => {
    seedRow({ id: `deferred-${status}`, action_type: 'add_inbox_task', payload: { title: 'Still pending' } });
    fake.pushStatus = status;
    await drainConnectorActions(session, DEVICE);
    expect(fake.rows[0].status).toBe('claimed');
    expect(fake.sequence).toEqual(['rpc:claimed', 'push']);
  });
});
