import AsyncStorage from '@react-native-async-storage/async-storage';
import { PERSIST_STORAGE_KEY } from './persistence-keys';
import { recordDurabilityBackupFromRaw } from '../services/data-durability';

export const durableAppStateStorage = {
  async getItem(name: string) {
    const raw = await AsyncStorage.getItem(name);
    if (!raw) return null;

    if (name === PERSIST_STORAGE_KEY) {
      try {
        await recordDurabilityBackupFromRaw(raw, 'pre_hydration');
      } catch {
        // Backup failure must never block hydration/migration of the live app.
      }
    }

    return JSON.parse(raw);
  },

  async setItem(name: string, value: unknown) {
    const raw = JSON.stringify(value);
    await AsyncStorage.setItem(name, raw);

    if (name === PERSIST_STORAGE_KEY) {
      try {
        await recordDurabilityBackupFromRaw(raw, 'post_write');
      } catch {
        // The live write already succeeded; keep the app usable and let a
        // later write refresh the backup.
      }
    }
  },

  async removeItem(name: string) {
    await AsyncStorage.removeItem(name);
  },
};
