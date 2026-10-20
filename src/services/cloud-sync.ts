// All pull/push callers share one queue per authenticated session. There is no
// timestamp-based "my write" suppression: a Realtime event always reads and
// compares the actual payload, including same-clock writes by another device.
import {
  getCloudSyncBaseline, getLastSeenCloudUpdatedAt, outboundResult,
  sameCloudRevision, saveCloudSyncRecovery, setCloudSyncBaseline,
  type CloudSyncBaseline, type CloudSyncRecovery, type OutboundStatus,
} from './cloud-sync-guard';
import {
  buildCloudSyncPayload, cloudPayloadsEqual, CLOUD_SYNC_MIRROR_FIELDS, CLOUD_SYNC_PAYLOAD_KEYS,
  normalizeCloudSyncPayload, stableCloudValue, type CloudSyncPayload,
} from './cloud-sync-payload';
import { reconcileCloudState } from './cloud-sync-reconcile';
import { getSyncSession, trackSyncWork, type SyncSession } from './sync-session';
import type { CloudWriteOptions } from './supabase';

export type CloudPushResult = { status: OutboundStatus; deferred: boolean; cloudUpdatedAt: string | null };
export type CloudPullResult = { status: 'restored' | 'unchanged' | 'unknown' | 'canceled' };
export interface CloudMergeOptions {
  force: true;
  allowEmptyFields: readonly string[];
  reconciledHabitLog: boolean;
}
export interface CloudSyncMetadata {
  readBaseline(userId: string): Promise<CloudSyncBaseline | null>;
  readClock(userId: string): Promise<string | null>;
  writeBaseline(baseline: CloudSyncBaseline, isCurrent: () => boolean): Promise<boolean>;
  saveRecovery(recovery: CloudSyncRecovery, isCurrent: () => boolean): Promise<boolean>;
}
export interface CloudSyncDependencies {
  getPayload(): CloudSyncPayload;
  hasUserData(): boolean;
  merge(payload: CloudSyncPayload, options: CloudMergeOptions): void;
  subscribe(listener: () => void): () => void;
  load(userId: string): Promise<{ state: any; updatedAt: string | null } | null>;
  write(userId: string, payload: CloudSyncPayload, options: CloudWriteOptions): Promise<CloudPushResult>;
  metadata?: CloudSyncMetadata;
  track?<T>(session: SyncSession, work: Promise<T>): Promise<T>;
  debounceMs?: number;
  fallbackMs?: number;
  habitCompletionXP?: number;
}

interface SessionState {
  tail: Promise<unknown>;
  metadataLoaded: boolean;
  baseline: CloudSyncBaseline | null;
  legacyClock: string | null;
  revision: number;
  readReady: boolean;
  mirrorDirty: boolean;
  applying: boolean;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  fallback: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
  observed: CloudSyncPayload;
}

/** Each factory has an independent store, metadata and scheduling state. The
 * production singleton and the two-device tests use this same implementation. */
export function createCloudSyncCoordinator(deps: CloudSyncDependencies) {
  const metadata: CloudSyncMetadata = deps.metadata ?? {
    readBaseline: getCloudSyncBaseline, readClock: getLastSeenCloudUpdatedAt,
    writeBaseline: setCloudSyncBaseline, saveRecovery: saveCloudSyncRecovery,
  };
  const sessions = new WeakMap<SyncSession, SessionState>();
  const snapshot = () => normalizeCloudSyncPayload(deps.getPayload());
  const mirrorsEqual = (a: CloudSyncPayload, b: CloudSyncPayload) =>
    CLOUD_SYNC_MIRROR_FIELDS.every((key) => stableCloudValue(a[key]) === stableCloudValue(b[key]));

  function context(session: SyncSession): SessionState {
    let state = sessions.get(session);
    if (!state) {
      state = {
        tail: Promise.resolve(), metadataLoaded: false, baseline: null, legacyClock: null,
        revision: 0, readReady: false, mirrorDirty: false, applying: false, started: false,
        timer: null, fallback: null, unsubscribe: null, observed: snapshot(),
      };
      sessions.set(session, state);
      session.onStop(() => cleanup(state!));
    }
    return state;
  }

  function cleanup(state: SessionState): void {
    if (state.timer !== null) clearTimeout(state.timer);
    if (state.fallback !== null) clearInterval(state.fallback);
    state.timer = null;
    state.fallback = null;
    state.unsubscribe?.();
    state.unsubscribe = null;
    state.started = false;
  }

  function enqueue<T>(session: SyncSession, canceled: T, operation: (state: SessionState) => Promise<T>): Promise<T> {
    if (!session.isCurrent()) return Promise.resolve(canceled);
    const state = context(session);
    const result = state.tail.then(() => session.isCurrent() ? operation(state) : canceled);
    state.tail = result.then(() => undefined, () => undefined);
    return (deps.track ?? trackSyncWork)(session, result);
  }

  async function loadMetadata(session: SyncSession, state: SessionState): Promise<boolean> {
    if (state.metadataLoaded) return session.isCurrent();
    const [baseline, clock] = await Promise.all([
      metadata.readBaseline(session.userId), metadata.readClock(session.userId),
    ]);
    if (!session.isCurrent()) return false;
    state.baseline = baseline && baseline.userId === session.userId && baseline.version === 1 &&
      Number.isFinite(Date.parse(baseline.updatedAt))
      ? { ...baseline, payload: normalizeCloudSyncPayload(baseline.payload) } : null;
    state.legacyClock = clock;
    state.metadataLoaded = true;
    if (state.baseline) state.mirrorDirty = !mirrorsEqual(snapshot(), state.baseline.payload);
    return true;
  }

  function hasPendingCloudChanges(session: SyncSession): boolean {
    if (!session.isCurrent()) return true;
    const state = context(session);
    if (!state.metadataLoaded || !state.readReady) return true;
    if (!state.baseline) return deps.hasUserData();
    const current = snapshot();
    // Intl time-zone changes do not emit a Zustand mutation. Compare against
    // our own observation, not another device's server mirror.
    return state.mirrorDirty || !mirrorsEqual(current, state.observed) ||
      !cloudPayloadsEqual(current, state.baseline.payload, true);
  }

  function schedulePush(session: SyncSession, state: SessionState): void {
    if (!session.isCurrent()) return;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      if (session.isCurrent()) void requestCloudPush(session);
    }, deps.debounceMs ?? 3000);
  }

  async function accept(session: SyncSession, state: SessionState, payload: CloudSyncPayload, updatedAt: string): Promise<boolean> {
    if (!session.isCurrent()) return false;
    const baseline: CloudSyncBaseline = {
      version: 1, userId: session.userId, updatedAt, payload: normalizeCloudSyncPayload(payload),
    };
    if (!await metadata.writeBaseline(baseline, session.isCurrent) || !session.isCurrent()) {
      state.readReady = false;
      return false;
    }
    if (!state.baseline || !sameCloudRevision(state.baseline.updatedAt, updatedAt) ||
        !cloudPayloadsEqual(state.baseline.payload, baseline.payload)) state.revision++;
    state.baseline = baseline;
    state.legacyClock = updatedAt;
    state.readReady = true;
    return true;
  }

  async function pullNow(session: SyncSession, state: SessionState): Promise<CloudPullResult> {
    try {
      if (!await loadMetadata(session, state)) return { status: 'canceled' };
      const cloud = await deps.load(session.userId);
      if (!session.isCurrent()) return { status: 'canceled' };
      if (!cloud) {
        // Previously observed rows cannot safely become "virgin accounts"
        // merely because a SELECT returned no visible row.
        if (state.baseline || state.legacyClock) { state.readReady = false; return { status: 'unknown' }; }
        state.readReady = true;
        if (deps.hasUserData()) schedulePush(session, state);
        return { status: 'unchanged' };
      }
      if (!cloud.state || typeof cloud.state !== 'object' || Array.isArray(cloud.state) ||
          !cloud.updatedAt || !Number.isFinite(Date.parse(cloud.updatedAt))) {
        state.readReady = false;
        return { status: 'unknown' };
      }
      if (state.baseline && Date.parse(cloud.updatedAt) < Date.parse(state.baseline.updatedAt)) {
        state.readReady = false;
        return { status: 'unknown' };
      }
      const remote = normalizeCloudSyncPayload(cloud.state);
      // Safe upgrade path: an old scalar clock can establish a payload base
      // only when it identifies this exact fetched row (not just the same ms).
      const base = state.baseline?.payload ??
        (sameCloudRevision(state.legacyClock, cloud.updatedAt) ? remote : null);
      for (let attempt = 0; attempt < 3; attempt++) {
        const local = snapshot();
        state.mirrorDirty ||= !mirrorsEqual(local, state.observed);
        const reconciled = reconcileCloudState(base, local, remote, !deps.hasUserData(), deps.habitCompletionXP);
        if (reconciled.unknownHistory || reconciled.conflicts.length) {
          const saved = await metadata.saveRecovery({
            version: 1, userId: session.userId, capturedAt: new Date().toISOString(),
            reason: reconciled.unknownHistory ? 'unknown-history' : 'conflict',
            base, local, remote, conflicts: reconciled.conflicts,
          }, session.isCurrent);
          if (!session.isCurrent()) return { status: 'canceled' };
          if (!saved) { state.readReady = false; return { status: 'unknown' }; }
          // A save is asynchronous. Never apply a merge calculated before a
          // user edit that happened while its recovery record was being saved.
          if (!cloudPayloadsEqual(local, snapshot())) continue;
        }
        if (!session.isCurrent()) return { status: 'canceled' };
        const before = snapshot();
        state.applying = true;
        try {
          // These deliberate inbound-only legacy fields never ride the new
          // outbound allow-list, but keep their existing restore behavior.
          const inbound = { ...reconciled.payload };
          for (const key of ['activeChallenge', 'completedChallenges', 'firstActionIntent', 'firstHabitCompletedAt']) {
            if (cloud.state[key] !== undefined) inbound[key] = cloud.state[key];
          }
          deps.merge(inbound, {
            force: true, allowEmptyFields: reconciled.allowEmptyFields,
            reconciledHabitLog: reconciled.reconciledHabitLog,
          });
        } finally {
          state.applying = false;
          state.observed = snapshot();
        }
        // Accepted-read baseline is the REMOTE row, not the merged store.
        if (!await accept(session, state, remote, cloud.updatedAt)) {
          return { status: session.isCurrent() ? 'unknown' : 'canceled' };
        }
        if (hasPendingCloudChanges(session)) schedulePush(session, state);
        return { status: cloudPayloadsEqual(before, snapshot()) ? 'unchanged' : 'restored' };
      }
      state.readReady = false;
      return { status: 'unknown' };
    } catch {
      state.readReady = false;
      return { status: session.isCurrent() ? 'unknown' : 'canceled' };
    }
  }

  function requestCloudPull(session: SyncSession): Promise<CloudPullResult> {
    return enqueue(session, { status: 'canceled' }, (state) => pullNow(session, state));
  }

  async function pushNow(session: SyncSession, state: SessionState, explicit?: { payload: CloudSyncPayload; revision: number }): Promise<CloudPushResult> {
    try {
      if (!await loadMetadata(session, state)) return outboundResult('stale', null);
      if (!state.readReady) {
        const restored = await pullNow(session, state);
        if (restored.status === 'unknown' || restored.status === 'canceled') return outboundResult('unknown', null);
      }
      if (!session.isCurrent()) return outboundResult('stale', null);
      const payload = explicit?.payload ?? snapshot();
      const expected = state.baseline?.updatedAt ?? null;
      if (explicit && (explicit.revision !== state.revision || !cloudPayloadsEqual(payload, snapshot()))) {
        return outboundResult('stale', expected);
      }
      if (!explicit && !hasPendingCloudChanges(session)) {
        // This status only acknowledges automatic work. Explicit requests
        // below always send their own exact payload rather than borrowing it.
        return outboundResult('written', expected);
      }
      const version = state.revision;
      const written = await deps.write(session.userId, payload, {
        isCurrent: session.isCurrent,
        canWrite: explicit ? () => state.revision === version && cloudPayloadsEqual(payload, snapshot()) : undefined,
        expectedUpdatedAt: expected, persistClock: false,
      });
      if (!session.isCurrent()) return outboundResult('stale', written.cloudUpdatedAt);
      if (written.status === 'written' && written.cloudUpdatedAt) {
        // Edits made during the network write are NOT acknowledged. Only
        // payload (captured above) becomes the next base; the live store stays.
        if (!await accept(session, state, payload, written.cloudUpdatedAt)) return outboundResult('unknown', written.cloudUpdatedAt);
        state.observed = snapshot();
        state.mirrorDirty = !mirrorsEqual(state.observed, payload);
        if (hasPendingCloudChanges(session)) schedulePush(session, state);
      } else if (written.status === 'stale') {
        await pullNow(session, state);
      }
      return written;
    } catch {
      return outboundResult(session.isCurrent() ? 'unknown' : 'stale', null);
    }
  }

  function requestCloudPush(session: SyncSession): Promise<CloudPushResult> {
    return enqueue(session, outboundResult('stale', null), (state) => pushNow(session, state));
  }

  function pushCloudSnapshot(session: SyncSession, payload: CloudSyncPayload): Promise<CloudPushResult> {
    const state = context(session);
    const explicit = { payload: normalizeCloudSyncPayload(payload), revision: state.revision };
    return enqueue(session, outboundResult('stale', null), (current) => pushNow(session, current, explicit));
  }

  function flushCloudSync(session: SyncSession): Promise<CloudPushResult> {
    const state = context(session);
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    return requestCloudPush(session);
  }

  function startCloudSync(session: SyncSession): () => void {
    const state = context(session);
    if (!session.isCurrent()) return () => {};
    if (!state.started) {
      state.started = true;
      state.mirrorDirty ||= !mirrorsEqual(snapshot(), state.observed);
      state.observed = snapshot();
      state.unsubscribe = deps.subscribe(() => {
        if (!session.isCurrent()) return;
        const current = snapshot();
        const previous = state.observed;
        state.observed = current;
        if (state.applying || cloudPayloadsEqual(previous, current)) return;
        if (!mirrorsEqual(previous, current)) state.mirrorDirty = true;
        schedulePush(session, state);
      });
      state.fallback = setInterval(() => {
        if (session.isCurrent()) void requestCloudPull(session).then(() => requestCloudPush(session));
      }, deps.fallbackMs ?? 5 * 60 * 1000);
      if (hasPendingCloudChanges(session)) schedulePush(session, state);
    }
    return () => cleanup(state);
  }

  return {
    restoreFromCloud: requestCloudPull, requestCloudPull, requestCloudPush,
    pushCloudSnapshot, flushCloudSync, startCloudSync, hasPendingCloudChanges,
  };
}

// Lazy platform edges keep the factory and leaf lifecycle tests RN-free, and
// keep sign-out/store ownership independent of Supabase/analytics imports.
let runtime: ReturnType<typeof createCloudSyncCoordinator> | null = null;
let runtimePromise: Promise<ReturnType<typeof createCloudSyncCoordinator>> | null = null;
function getRuntime() {
  if (!runtimePromise) runtimePromise = Promise.all([
    import('./supabase'), import('../state/app-state'),
  ]).then(([cloud, app]) => {
    runtime = createCloudSyncCoordinator({
      getPayload: () => buildCloudSyncPayload(app.useAppState.getState()),
      hasUserData: () => app.localStoreHasUserData(app.useAppState.getState()),
      merge: (payload, options) => app.useAppState.getState().mergeCloudState(payload, options),
      subscribe: (listener) => app.useAppState.subscribe((current, previous) => {
        // Local screen/modal/voice activity does not serialize the entire
        // cloud blob or wake the writer. Canonical comparison below further
        // ignores device-only members inside otherwise shared objects.
        if (CLOUD_SYNC_PAYLOAD_KEYS.some((key) => (current as any)[key] !== (previous as any)[key])) listener();
      }),
      load: cloud.loadStateFromCloud, write: cloud.syncStateToCloud,
      habitCompletionXP: app.XP_HABIT_COMPLETE,
    });
    return runtime;
  });
  return runtimePromise;
}

export function restoreFromCloud(session: SyncSession): Promise<CloudPullResult> {
  return trackSyncWork(session, getRuntime().then((sync) => sync.restoreFromCloud(session)));
}
export function requestCloudPull(session: SyncSession): Promise<CloudPullResult> {
  return trackSyncWork(session, getRuntime().then((sync) => sync.requestCloudPull(session)));
}
export function requestCloudPush(session: SyncSession): Promise<CloudPushResult> {
  return trackSyncWork(session, getRuntime().then((sync) => sync.requestCloudPush(session)));
}
export function pushCloudSnapshot(session: SyncSession, payload: CloudSyncPayload): Promise<CloudPushResult> {
  const immutable = normalizeCloudSyncPayload(payload);
  // Capture the coordinator revision at invocation, before yielding to an
  // already-resolved runtime promise and another queued operation.
  if (runtime) return runtime.pushCloudSnapshot(session, immutable);
  return trackSyncWork(session, getRuntime().then((sync) => sync.pushCloudSnapshot(session, immutable)));
}
export function flushCloudSync(session: SyncSession): Promise<CloudPushResult> {
  return trackSyncWork(session, getRuntime().then((sync) => sync.flushCloudSync(session)));
}
export function hasPendingCloudChanges(session: SyncSession): boolean {
  return runtime ? runtime.hasPendingCloudChanges(session) : true;
}
export function startCloudSync(session: SyncSession): () => void {
  let stopped = false;
  let cleanup = () => {};
  void getRuntime().then((sync) => { if (!stopped && session.isCurrent()) cleanup = sync.startCloudSync(session); });
  return () => { stopped = true; cleanup(); };
}

/** Compatibility for older internal callers; never invent a new session. */
export async function convergeFromCloud(userId: string): Promise<void> {
  const session = getSyncSession(userId);
  if (session) await requestCloudPull(session);
}
