import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_SYNC_BASELINE_PREFIX, CLOUD_SYNC_PAYLOAD_BASELINE_PREFIX, CLOUD_SYNC_RECOVERY_PREFIX,
  clearCloudSyncMetadata, getCloudSyncBaseline, getLastSeenCloudUpdatedAt,
  sameCloudRevision, saveCloudSyncRecovery, setCloudSyncBaseline, setLastSeenCloudUpdatedAt,
  type CloudSyncBaseline,
} from '../cloud-sync-guard';
const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  beforeSet: null as null | ((key: string) => Promise<void>),
  fail: false,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => storage.values.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    if (storage.beforeSet) await storage.beforeSet(key);
    if (storage.fail) throw new Error('disk unavailable');
    storage.values.set(key, value);
  }),
  getAllKeys: vi.fn(async () => [...storage.values.keys()]),
  multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((key) => storage.values.delete(key)); }),
} }));

const time = '2026-09-12T12:00:00.000Z';
const baseline = (userId = 'one'): CloudSyncBaseline => ({ version: 1, userId, updatedAt: time, payload: { inbox: [{ id: 'a' }] } });

beforeEach(async () => {
  storage.fail = false;
  storage.beforeSet = null;
  await clearCloudSyncMetadata();
  storage.values.clear();
});

describe('versioned acknowledged metadata', () => {
  it('retains the old scalar clock alongside a validated user-bound payload', async () => {
    expect(await setCloudSyncBaseline(baseline())).toBe(true);
    expect(await getCloudSyncBaseline('one')).toEqual(baseline());
    expect(await getLastSeenCloudUpdatedAt('one')).toBe(time);
    expect(storage.values.get(CLOUD_SYNC_BASELINE_PREFIX + 'one')).toBe(time);
    expect(await getCloudSyncBaseline('two')).toBeNull();
  });

  it('does not interpret legacy scalar data, malformed JSON or wrong-user envelopes as a payload baseline', async () => {
    await setLastSeenCloudUpdatedAt('one', time);
    expect(await getCloudSyncBaseline('one')).toBeNull();
    for (const value of ['bad-json', JSON.stringify(baseline('two')), JSON.stringify({ ...baseline(), version: 2 }), JSON.stringify({ ...baseline(), updatedAt: 'bad' })]) {
      storage.values.set(CLOUD_SYNC_PAYLOAD_BASELINE_PREFIX + 'one', value);
      expect(await getCloudSyncBaseline('one')).toBeNull();
    }
  });

  it('serializes cleanup behind an in-flight write and rejects stale queued writes', async () => {
    let release!: () => void, began!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { began = resolve; });
    storage.beforeSet = async () => { began(); await gate; };
    let current = true;
    const first = setCloudSyncBaseline(baseline(), () => current);
    await started;
    const queued = setCloudSyncBaseline({ ...baseline(), payload: { inbox: [{ id: 'late' }] } }, () => current);
    current = false;
    const cleared = clearCloudSyncMetadata('one');
    release();
    expect(await first).toBe(false);
    expect(await queued).toBe(false);
    await cleared;
    expect([...storage.values.keys()]).toEqual([]);
    expect(await setCloudSyncBaseline(baseline(), () => current)).toBe(false);
    expect([...storage.values.keys()]).toEqual([]);
  });

  it('preserves each conflicting value in a separate scoped record and clears only that user', async () => {
    const recovery = {
      version: 1 as const, userId: 'one', capturedAt: time, reason: 'conflict' as const,
      base: {}, local: { inbox: [{ id: 'a' }] }, remote: { inbox: [{ id: 'b' }] }, conflicts: ['inbox'],
    };
    expect(await saveCloudSyncRecovery(recovery)).toBe(true);
    expect(await saveCloudSyncRecovery({ ...recovery, local: { inbox: [{ id: 'c' }] } })).toBe(true);
    await setCloudSyncBaseline(baseline('two'));
    expect([...storage.values.keys()].filter((key) => key.startsWith(CLOUD_SYNC_RECOVERY_PREFIX + 'one.'))).toHaveLength(2);
    await clearCloudSyncMetadata('one');
    expect([...storage.values.keys()].some((key) => key.startsWith(CLOUD_SYNC_RECOVERY_PREFIX))).toBe(false);
    expect(await getCloudSyncBaseline('two')).toEqual(baseline('two'));
  });

  it('fails closed on acknowledgement and recovery write errors', async () => {
    storage.fail = true;
    expect(await setCloudSyncBaseline(baseline())).toBe(false);
    expect(await saveCloudSyncRecovery({ version: 1, userId: 'one', capturedAt: time, reason: 'unknown-history', base: null, local: {}, remote: {}, conflicts: [] })).toBe(false);
  });

  it('takes an immutable snapshot before queuing its write', async () => {
    const payload = baseline();
    const work = setCloudSyncBaseline(payload);
    payload.payload.inbox.push({ id: 'not-acknowledged' });
    await work;
    expect((await getCloudSyncBaseline('one'))?.payload.inbox).toEqual([{ id: 'a' }]);
  });

  it('distinguishes microsecond revisions while accepting equivalent PostgREST spelling', () => {
    expect(sameCloudRevision(time, '2026-09-12T12:00:00.000+00:00')).toBe(true);
    expect(sameCloudRevision('2026-09-12T12:00:00.000001Z', '2026-09-12T12:00:00.000002Z')).toBe(false);
    expect(sameCloudRevision('2026-09-12T12:00:00.1Z', '2026-09-12T12:00:00.100000+00:00')).toBe(true);
  });
});
