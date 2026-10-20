import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));
import { createCloudSyncCoordinator, type CloudSyncDependencies, type CloudSyncMetadata } from '../cloud-sync';
import { createSyncSessionManager } from '../sync-session';
import { outboundResult, type CloudSyncBaseline, type CloudSyncRecovery } from '../cloud-sync-guard';

const T0 = '2026-09-12T12:00:00.000Z';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const stops: Array<() => void> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function cloud(initial: Record<string, any>) {
  let row = { state: clone(initial), updatedAt: T0 };
  const writes: any[] = [];
  const load = vi.fn(async () => clone(row));
  const write = vi.fn<CloudSyncDependencies['write']>(async (userId, payload, options) => {
    if (!options.isCurrent?.() || (options.canWrite && !options.canWrite()) ||
        options.expectedUpdatedAt !== row.updatedAt) return outboundResult('stale', row.updatedAt);
    row = { state: clone(payload), updatedAt: new Date(Date.parse(row.updatedAt) + 1).toISOString() };
    writes.push({ userId, ...clone(row) });
    return outboundResult('written', row.updatedAt);
  });
  return {
    load, write, writes,
    get row() { return clone(row); },
    change(state: Record<string, any>) {
      row = { state: clone(state), updatedAt: new Date(Date.parse(row.updatedAt) + 1).toISOString() };
    },
  };
}
function device(initial: Record<string, any>, server: ReturnType<typeof cloud>, options: {
  baseline?: CloudSyncBaseline | null; userId?: string;
} = {}) {
  const userId = options.userId ?? 'owner';
  let local = clone(initial);
  let baseline: CloudSyncBaseline | null = options.baseline === undefined
    ? { version: 1, userId, updatedAt: T0, payload: clone(initial) } : clone(options.baseline);
  const recoveries: CloudSyncRecovery[] = [];
  const listeners = new Set<() => void>();
  const manager = createSyncSessionManager();
  const session = manager.begin(userId);
  stops.push(() => manager.stop());
  const metadata: CloudSyncMetadata = {
    readBaseline: vi.fn(async () => clone(baseline)),
    readClock: vi.fn(async () => baseline?.updatedAt ?? null),
    writeBaseline: vi.fn(async (next, current) => {
      if (!current()) return false;
      baseline = clone(next);
      return true;
    }),
    saveRecovery: vi.fn(async (recovery, current) => {
      if (!current()) return false;
      recoveries.push(clone(recovery));
      return true;
    }),
  };
  const deps: CloudSyncDependencies = {
    getPayload: () => local,
    hasUserData: () => true,
    merge: vi.fn((payload) => { local = { ...local, ...clone(payload) }; for (const fn of listeners) fn(); }),
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    load: server.load, write: server.write, metadata, track: manager.track,
    debounceMs: 30, fallbackMs: 10000,
  };
  const sync = createCloudSyncCoordinator(deps);
  return {
    sync, session, manager, metadata, deps, recoveries,
    get local() { return clone(local); },
    get baseline() { return clone(baseline); },
    edit(patch: Record<string, any>) { local = { ...local, ...clone(patch) }; for (const fn of listeners) fn(); },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { stops.splice(0).forEach((stop) => stop()); vi.clearAllTimers(); vi.useRealTimers(); });

describe('independent device sync coordinator', () => {
  it('converges same-week wins after a stale write without losing either device addition', async () => {
    const base = { weeklyWins: ['shared'], weeklyWinsDate: '2026-09-13' };
    const server = cloud(base);
    const a = device(base, server), b = device(base, server);
    await Promise.all([a.sync.restoreFromCloud(a.session), b.sync.restoreFromCloud(b.session)]);
    a.sync.startCloudSync(a.session); b.sync.startCloudSync(b.session);
    a.edit({ weeklyWins: [...base.weeklyWins, 'phone'] });
    b.edit({ weeklyWins: [...base.weeklyWins, 'tablet'] });
    expect((await a.sync.flushCloudSync(a.session)).status).toBe('written');
    expect((await b.sync.flushCloudSync(b.session)).status).toBe('stale');
    expect(b.local.weeklyWins).toEqual(['phone', 'shared', 'tablet']);
    expect((await b.sync.flushCloudSync(b.session)).status).toBe('written');
    await a.sync.requestCloudPull(a.session);
    expect(a.local).toEqual(b.local);
    expect(server.row.state).toEqual(a.local);
    expect(a.sync.hasPendingCloudChanges(a.session)).toBe(false);
    expect(b.sync.hasPendingCloudChanges(b.session)).toBe(false);
    const count = server.writes.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(server.writes).toHaveLength(count);
  });

  it('preserves concurrent collection additions, then both devices become quiet', async () => {
    const base = { inbox: [{ id: 'original', text: 'original' }], softMode: false };
    const server = cloud(base);
    const a = device(base, server), b = device(base, server);
    await Promise.all([a.sync.restoreFromCloud(a.session), b.sync.restoreFromCloud(b.session)]);
    a.sync.startCloudSync(a.session); b.sync.startCloudSync(b.session);
    a.edit({ inbox: [...base.inbox, { id: 'a', text: 'phone' }] });
    b.edit({ inbox: [...base.inbox, { id: 'b', text: 'tablet' }] });
    expect((await a.sync.flushCloudSync(a.session)).status).toBe('written');
    expect((await b.sync.flushCloudSync(b.session)).status).toBe('stale');
    expect(b.local.inbox.map((item: any) => item.id).sort()).toEqual(['a', 'b', 'original']);
    expect((await b.sync.flushCloudSync(b.session)).status).toBe('written');
    await a.sync.requestCloudPull(a.session);
    expect(a.local).toEqual(b.local);
    expect(a.sync.hasPendingCloudChanges(a.session)).toBe(false);
    expect(b.sync.hasPendingCloudChanges(b.session)).toBe(false);
    const count = server.writes.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(server.writes).toHaveLength(count);
  });

  it('re-reads local edits made while the remote fetch was in flight', async () => {
    const base = { inbox: [{ id: 'base', text: 'base' }] };
    const server = cloud(base), d = device(base, server);
    await d.sync.restoreFromCloud(d.session);
    server.change({ inbox: [...base.inbox, { id: 'remote', text: 'new remote' }] });
    const fetched = server.row;
    const gate = deferred<typeof fetched>(), entered = deferred<void>();
    server.load.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const pull = d.sync.requestCloudPull(d.session);
    await entered.promise;
    d.edit({ inbox: [...base.inbox, { id: 'local', text: 'new local' }] });
    gate.resolve(fetched);
    await pull;
    expect(d.local.inbox.map((item: any) => item.id).sort()).toEqual(['base', 'local', 'remote']);
    expect(d.baseline?.payload).toEqual(fetched.state);
    expect(d.sync.hasPendingCloudChanges(d.session)).toBe(true);
  });

  it('acknowledges only the payload sent before an edit during the write', async () => {
    const base = { inbox: [{ id: 'base', text: 'base' }] };
    const server = cloud(base), d = device(base, server);
    await d.sync.restoreFromCloud(d.session);
    const send = server.write.getMockImplementation()!;
    const gate = deferred<void>(), entered = deferred<void>();
    server.write.mockImplementationOnce(async (...args) => {
      entered.resolve(); await gate.promise; return send(...args);
    });
    d.edit({ inbox: [...base.inbox, { id: 'first', text: 'sent' }] });
    const push = d.sync.requestCloudPush(d.session);
    await entered.promise;
    d.edit({ inbox: [...d.local.inbox, { id: 'later', text: 'unsent' }] });
    gate.resolve(); await push;
    expect(d.baseline?.payload.inbox.map((item: any) => item.id)).toEqual(['base', 'first']);
    expect(d.sync.hasPendingCloudChanges(d.session)).toBe(true);
    await d.sync.flushCloudSync(d.session);
    expect(server.row.state.inbox.map((item: any) => item.id)).toEqual(['base', 'first', 'later']);
    expect(d.sync.hasPendingCloudChanges(d.session)).toBe(false);
  });

  it('uses a persisted accepted payload after an offline app restart', async () => {
    const base = { inbox: [{ id: 'base', text: 'base' }] };
    const server = cloud(base), old = device(base, server);
    await old.sync.restoreFromCloud(old.session);
    const accepted = old.baseline;
    old.manager.stop();
    server.change({ inbox: [...base.inbox, { id: 'remote', text: 'tablet' }] });
    const restarted = device({ inbox: [...base.inbox, { id: 'offline', text: 'phone' }] }, server, { baseline: accepted });
    await restarted.sync.restoreFromCloud(restarted.session);
    expect(restarted.local.inbox.map((item: any) => item.id).sort()).toEqual(['base', 'offline', 'remote']);
    expect(restarted.baseline?.payload).toEqual(server.row.state);
  });

  it('refuses an unknown-history merge until its recovery copy is saved', async () => {
    const server = cloud({ inbox: [{ id: 'remote', text: 'cloud' }] });
    const local = { inbox: [{ id: 'local', text: 'unsynced' }] };
    const d = device(local, server, { baseline: null });
    vi.mocked(d.metadata.saveRecovery).mockResolvedValueOnce(false);
    expect((await d.sync.restoreFromCloud(d.session)).status).toBe('unknown');
    expect(d.local).toEqual(local);
    expect(d.baseline).toBeNull();
    expect(server.writes).toHaveLength(0);
    await d.sync.restoreFromCloud(d.session);
    expect(d.recoveries[0]).toMatchObject({ userId: 'owner', reason: 'unknown-history', local });
    expect(d.local.inbox.map((item: any) => item.id).sort()).toEqual(['local', 'remote']);
  });

  it('reconciles again when an edit arrives during recovery storage', async () => {
    const server = cloud({ inbox: [{ id: 'remote', text: 'cloud' }] });
    const d = device({ inbox: [{ id: 'local', text: 'phone' }] }, server, { baseline: null });
    const gate = deferred<boolean>(), entered = deferred<void>();
    vi.mocked(d.metadata.saveRecovery).mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const pull = d.sync.restoreFromCloud(d.session);
    await entered.promise;
    d.edit({ inbox: [...d.local.inbox, { id: 'late', text: 'edited during storage' }] });
    gate.resolve(true); await pull;
    expect(d.metadata.saveRecovery).toHaveBeenCalledTimes(2);
    expect(d.local.inbox.map((item: any) => item.id).sort()).toEqual(['late', 'local', 'remote']);
    expect(d.baseline?.payload).toEqual(server.row.state);
  });

  it('cannot apply a delayed old-account read or its queued write to a new owner', async () => {
    const server = cloud({ inbox: [{ id: 'private-a', text: 'account A' }] });
    const d = device({ inbox: [] }, server, { baseline: null });
    const gate = deferred<ReturnType<typeof server.load> extends Promise<infer T> ? T : never>();
    const entered = deferred<void>();
    server.load.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const pull = d.sync.requestCloudPull(d.session);
    await entered.promise;
    const queued = d.sync.pushCloudSnapshot(d.session, d.local);
    d.manager.stop(); d.manager.begin('other-owner');
    d.edit({ inbox: [{ id: 'private-b', text: 'account B' }] });
    gate.resolve(server.row);
    expect((await pull).status).toBe('canceled');
    expect((await queued).deferred).toBe(true);
    expect(d.local.inbox[0].id).toBe('private-b');
    expect(d.metadata.writeBaseline).not.toHaveBeenCalled();
    expect(server.write).not.toHaveBeenCalled();
  });

  it('does not give a queued explicit snapshot another snapshot’s success', async () => {
    const base = { inbox: [{ id: 'base', text: 'base' }] };
    const server = cloud(base), d = device(base, server);
    await d.sync.restoreFromCloud(d.session);
    const send = server.write.getMockImplementation()!;
    const gate = deferred<void>(), entered = deferred<void>();
    server.write.mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return send(...args); });
    d.edit({ inbox: [...base.inbox, { id: 'one', text: 'first action' }] });
    const first = d.sync.requestCloudPush(d.session);
    await entered.promise;
    d.edit({ inbox: [...d.local.inbox, { id: 'two', text: 'second action' }] });
    const second = d.sync.pushCloudSnapshot(d.session, d.local);
    gate.resolve();
    expect((await first).status).toBe('written');
    expect((await second).status).toBe('stale');
    expect(server.write).toHaveBeenCalledTimes(1);
    expect(server.row.state.inbox.map((item: any) => item.id)).toEqual(['base', 'one']);
  });

  it('does not write after an unreadable remote row', async () => {
    const server = cloud({ inbox: [] }), d = device({ inbox: [{ id: 'local' }] }, server, { baseline: null });
    server.load.mockRejectedValue(new Error('offline'));
    expect((await d.sync.requestCloudPush(d.session)).status).toBe('unknown');
    expect(server.write).not.toHaveBeenCalled();
    expect(d.sync.hasPendingCloudChanges(d.session)).toBe(true);
  });

  it('does not claim success when checkpoint storage fails after a network write', async () => {
    const base = { inbox: [{ id: 'base' }] };
    const server = cloud(base), d = device(base, server);
    await d.sync.restoreFromCloud(d.session);
    vi.mocked(d.metadata.writeBaseline).mockResolvedValueOnce(false);
    d.edit({ inbox: [...base.inbox, { id: 'new' }] });
    expect((await d.sync.flushCloudSync(d.session)).status).toBe('unknown');
    expect(d.baseline?.payload).toEqual(base);
    expect(d.sync.hasPendingCloudChanges(d.session)).toBe(true);
  });

  it('ignores remote-only mirror differences while pushing genuine local mirror edits', async () => {
    const base = { inbox: [{ id: 'base' }], timezone: 'America/Chicago', dailyWisdomDate: '2026-09-11' };
    const server = cloud(base), d = device(base, server);
    await d.sync.restoreFromCloud(d.session); d.sync.startCloudSync(d.session);
    server.change({ ...base, timezone: 'Europe/Paris' });
    await d.sync.requestCloudPull(d.session);
    expect(d.local.timezone).toBe('America/Chicago');
    expect(d.sync.hasPendingCloudChanges(d.session)).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(server.writes).toHaveLength(0);
    d.edit({ dailyWisdomDate: '2026-09-12' });
    await vi.advanceTimersByTimeAsync(50);
    expect(server.writes).toHaveLength(1);
    expect(server.row.state.dailyWisdomDate).toBe('2026-09-12');
  });

  it.each(['pull', 'flush', 'restart'])('saves a system time-zone change on %s without a store event or an echo', async (trigger) => {
    const base = { inbox: [{ id: 'base' }], timezone: 'America/Chicago' };
    const server = cloud(base), d = device(base, server);
    let timezone = base.timezone;
    // Production derives this from Intl, so changing time zone emits no store event.
    d.deps.getPayload = () => ({ ...d.local, timezone });
    await d.sync.restoreFromCloud(d.session);
    const stop = d.sync.startCloudSync(d.session);
    timezone = 'Europe/Paris';
    if (trigger === 'pull') await d.sync.requestCloudPull(d.session);
    else if (trigger === 'flush') await d.sync.flushCloudSync(d.session);
    else { stop(); d.sync.startCloudSync(d.session); }
    await vi.advanceTimersByTimeAsync(50);
    expect(server.row.state.timezone).toBe('Europe/Paris');
    expect(d.sync.hasPendingCloudChanges(d.session)).toBe(false);
    const writes = server.writes.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(server.writes).toHaveLength(writes);
  });
});
