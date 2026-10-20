import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_DELETION_PENDING_PREFIX, clearStorageAfterAccountDeletion, createAccountDeletionMarkers } from '../sync-account-deletion';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}),
} }));

describe('persistent account-deletion pause', () => {
  it('survives a new lifecycle and is scoped to the account', async () => {
    const disk = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => disk.get(key) ?? null,
      setItem: async (key: string, value: string) => { disk.set(key, value); },
    };
    await createAccountDeletionMarkers(storage).markPending('A');
    const restarted = createAccountDeletionMarkers(storage);
    expect(await restarted.isPending('A')).toBe(true);
    expect(await restarted.isPending('B')).toBe(false);
  });

  it('does not finish the durable barrier before its disk write completes', async () => {
    let finish!: () => void;
    const diskWrite = new Promise<void>((resolve) => { finish = resolve; });
    const markers = createAccountDeletionMarkers({
      getItem: async () => '1', setItem: () => diskWrite,
    });
    let confirmed = false;
    const marked = markers.markPending('A').then(() => { confirmed = true; });
    await Promise.resolve();
    expect(confirmed).toBe(false);
    finish();
    await marked;
    expect(confirmed).toBe(true);
  });

  it('a failed durable write rejects; a failed read never authorizes restoring', async () => {
    const markers = createAccountDeletionMarkers({
      getItem: async () => { throw new Error('disk unavailable'); },
      setItem: async () => { throw new Error('disk full'); },
    });
    await expect(markers.markPending('A')).rejects.toThrow('disk full');
    expect(await markers.isPending('A')).toBe(true);
  });

  it('deleting B preserves the unfinished deletion marker for A', async () => {
    const disk = new Map([
      [ACCOUNT_DELETION_PENDING_PREFIX + 'A', '1'],
      [ACCOUNT_DELETION_PENDING_PREFIX + 'B', '1'],
      ['session-token', 'B-session'],
      ['persisted-state', 'B-data'],
    ]);
    const storage = {
      getAllKeys: async () => [...disk.keys()],
      multiRemove: async (keys: string[]) => { for (const key of keys) disk.delete(key); },
    };
    expect(await clearStorageAfterAccountDeletion('B', () => true, storage)).toBe(true);
    expect([...disk.keys()]).toEqual([ACCOUNT_DELETION_PENDING_PREFIX + 'A']);
    const restarted = createAccountDeletionMarkers({
      getItem: async (key) => disk.get(key) ?? null,
      setItem: async (key, value) => { disk.set(key, value); },
    });
    expect(await restarted.isPending('A')).toBe(true);
    expect(await restarted.isPending('B')).toBe(false);
  });

  it('does not remove storage if auth changes during key enumeration', async () => {
    let current = true;
    const storage = {
      getAllKeys: async () => { current = false; return ['new-account-session']; },
      multiRemove: vi.fn(async () => {}),
    };
    expect(await clearStorageAfterAccountDeletion('A', () => current, storage)).toBe(false);
    expect(storage.multiRemove).not.toHaveBeenCalled();
  });
});
