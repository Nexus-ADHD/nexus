import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncStateToCloud } from '../supabase';
const remote = vi.hoisted(() => ({
  clock: '2026-09-12T12:00:00.000Z' as string | null,
  readError: false,
  beforeRead: null as null | (() => Promise<void>),
  beforeWrite: null as null | (() => Promise<void>),
  readCount: 0,
  writes: [] as any[],
  metadata: new Map<string, string>(),
  matched: 1,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => remote.metadata.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { remote.metadata.set(key, value); }),
} }));
vi.mock('../../utils/public-config', () => ({
  publicConfigValue: (key: string) => key.includes('URL') ? 'https://example.supabase.co' : 'test-key',
  publicConfigSource: () => 'test',
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  from: () => {
    const chain: any = {
      eq: () => chain,
      maybeSingle: async () => {
        remote.readCount++;
        await remote.beforeRead?.();
        return { data: remote.clock ? { updated_at: remote.clock } : null, error: remote.readError ? { message: 'unreadable' } : null };
      },
      select: () => chain,
      update: (value: any) => {
        chain.select = async () => {
          remote.writes.push(value);
          await remote.beforeWrite?.();
          return { data: remote.matched ? [{ updated_at: value.updated_at }] : [], count: remote.matched, error: null };
        };
        return chain;
      },
      insert: async (value: any) => {
        remote.writes.push(value);
        await remote.beforeWrite?.();
        return { error: null };
      },
    };
    return chain;
  },
}) }));
const time = '2026-09-12T12:00:00.000Z';
const snapshot = { inbox: [{ id: 'a' }] };

beforeEach(() => {
  remote.clock = time; remote.readError = false; remote.beforeRead = null; remote.beforeWrite = null;
  remote.readCount = 0; remote.writes = []; remote.metadata.clear(); remote.matched = 1;
});

describe('owned conditional cloud writes', () => {
  it('does no read or mutation for an already invalid owner', async () => {
    expect((await syncStateToCloud('one', snapshot, { isCurrent: () => false })).status).toBe('stale');
    expect(remote.readCount).toBe(0);
    expect(remote.writes).toHaveLength(0);
  });

  it('checks ownership again after the cloud clock await', async () => {
    let current = true;
    remote.beforeRead = async () => { current = false; };
    const result = await syncStateToCloud('one', snapshot, { isCurrent: () => current, expectedUpdatedAt: time });
    expect(result.status).toBe('stale');
    expect(remote.writes).toHaveLength(0);
  });

  it('checks exact explicit snapshot freshness immediately before mutation', async () => {
    let fresh = true;
    remote.beforeRead = async () => { fresh = false; };
    const result = await syncStateToCloud('one', snapshot, { canWrite: () => fresh, expectedUpdatedAt: time });
    expect(result.status).toBe('stale');
    expect(remote.writes).toHaveLength(0);
  });

  it('refuses an unknown clock or a mismatched exact revision', async () => {
    remote.readError = true;
    expect((await syncStateToCloud('one', snapshot, { expectedUpdatedAt: time })).status).toBe('unknown');
    remote.readError = false;
    remote.clock = '2026-09-12T12:00:00.000001Z';
    expect((await syncStateToCloud('one', snapshot, { expectedUpdatedAt: time })).status).toBe('stale');
    expect(remote.writes).toHaveLength(0);
  });

  it('does not recreate metadata when ownership ends during the actual write', async () => {
    let current = true;
    remote.beforeWrite = async () => { current = false; };
    const result = await syncStateToCloud('one', snapshot, { isCurrent: () => current, expectedUpdatedAt: time });
    expect(remote.writes).toHaveLength(1);
    expect(result.status).toBe('stale');
    expect(remote.metadata.size).toBe(0);
  });

  it('only acknowledges an actual matched exact snapshot and leaves metadata to coordinator', async () => {
    const result = await syncStateToCloud('one', snapshot, { expectedUpdatedAt: time, persistClock: false });
    expect(result.status).toBe('written');
    expect(remote.writes[0].state_data).toEqual(snapshot);
    expect(remote.metadata.size).toBe(0);
    remote.matched = 0;
    expect((await syncStateToCloud('one', snapshot, { expectedUpdatedAt: time, persistClock: false })).status).toBe('stale');
  });

  it('inserts only after known row absence', async () => {
    remote.clock = null;
    expect((await syncStateToCloud('one', snapshot, { expectedUpdatedAt: null, persistClock: false })).status).toBe('written');
    expect(remote.writes[0].user_id).toBe('one');
  });
});
