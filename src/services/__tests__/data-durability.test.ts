import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSIST_STORAGE_KEY, PERSIST_VERSION } from '../../state/persistence-keys';
import { durableAppStateStorage } from '../../state/persistence';
import {
  DURABILITY_BACKUP_KEY,
  createDurabilityBackup,
  getDurabilityBackupStatus,
  restoreDurabilityBackup,
} from '../data-durability';

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { storage.delete(key); }),
  },
}));


const populatedPersistPayload = {
  state: {
    isActivated: true,
    recurringRules: [
      { id: 'habit-1', title: 'Meditate', daysOfWeek: [1, 2, 3, 4, 5], timesPerDay: 1, createdAt: 1710000000000 },
    ],
    habitLog: Array.from({ length: 45 }, (_, index) => ({
      habitTitle: 'Meditate',
      dateKey: `2026-04-${String((index % 30) + 1).padStart(2, '0')}`,
      timestamp: 1710000000000 + index,
    })),
    habitStreaks: { Meditate: 45 },
    horizonReviews: [{ id: 'review-1', periodLabel: 'W19', responses: {}, summary: 'Still here.' }],
    dailyScores: { '2026-05-28': 91 },
  },
  version: 23,
};

describe('data durability backup/restore', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('creates a visible status envelope for a populated persisted dataset', async () => {
    const raw = JSON.stringify(populatedPersistPayload);
    storage.set(PERSIST_STORAGE_KEY, raw);

    const backup = await createDurabilityBackup('manual');
    const status = await getDurabilityBackupStatus();

    expect(backup?.rawPersistedState).toBe(raw);
    expect(status).toMatchObject({
      isBackedUp: true,
      reason: 'manual',
      persistVersion: populatedPersistPayload.version,
      bytes: raw.length,
    });
    expect(status.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('backs up raw state before hydrate/migrate and restores it one tap later', async () => {
    const raw = JSON.stringify(populatedPersistPayload);
    storage.set(PERSIST_STORAGE_KEY, raw);

    const hydrated = await durableAppStateStorage.getItem(PERSIST_STORAGE_KEY);
    expect(hydrated).toEqual(populatedPersistPayload);

    storage.set(PERSIST_STORAGE_KEY, JSON.stringify({ state: { isActivated: false }, version: PERSIST_VERSION }));
    const restored = await restoreDurabilityBackup();

    expect(restored.rawPersistedState).toBe(raw);
    expect(storage.get(PERSIST_STORAGE_KEY)).toBe(raw);
    const backupEnvelope = JSON.parse(storage.get(DURABILITY_BACKUP_KEY) ?? '{}');
    expect(backupEnvelope.reason).toBe('pre_hydration');
  });

  it('backs up every post-write payload so app-update writes cannot strand the latest habit history', async () => {
    await durableAppStateStorage.setItem(PERSIST_STORAGE_KEY, populatedPersistPayload);

    const backupEnvelope = JSON.parse(storage.get(DURABILITY_BACKUP_KEY) ?? '{}');
    expect(backupEnvelope.reason).toBe('post_write');
    expect(JSON.parse(backupEnvelope.rawPersistedState)).toEqual(populatedPersistPayload);
  });

  it('preserves the pre-migration snapshot after the post-migration write lands', async () => {
    // User on v23 with real history.
    const v23 = JSON.stringify(populatedPersistPayload); // version: 23
    storage.set(PERSIST_STORAGE_KEY, v23);

    // App launches on v24 code: zustand reads (pre_hydration fires)...
    await durableAppStateStorage.getItem(PERSIST_STORAGE_KEY);

    // ...migrate() runs, then zustand persists migrated state through the
    // wrapper (post_write fires). Simulate a migration that silently corrupts:
    // arrays still populated, contents wrong.
    const corruptedV24 = {
      state: { isActivated: true, recurringRules: [{ id: 'habit-1', title: '' }], habitLog: [], habitStreaks: {} },
      version: PERSIST_VERSION,
    };
    await durableAppStateStorage.setItem(PERSIST_STORAGE_KEY, corruptedV24);

    // One tap must bring back the original v23 history, not the corrupted v24.
    const restored = await restoreDurabilityBackup();
    expect(restored.persistVersion).toBe(23);
    expect(restored.rawPersistedState).toBe(v23);
    expect(storage.get(PERSIST_STORAGE_KEY)).toBe(v23);
  });
});
