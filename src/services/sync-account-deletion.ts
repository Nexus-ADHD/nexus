import AsyncStorage from '@react-native-async-storage/async-storage';

// Intentionally outside baseline/recovery cleanup. A partially deleted account
// must stay paused across signout, account switches and process restarts.
export const ACCOUNT_DELETION_PENDING_PREFIX = 'nexus.accountDeletion.pending.';

interface DeletionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function createAccountDeletionMarkers(storage: DeletionStorage) {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    markPending(userId: string): Promise<void> {
      if (!userId) return Promise.reject(new Error('Account deletion requires a user'));
      const work = tail.then(() => storage.setItem(ACCOUNT_DELETION_PENDING_PREFIX + userId, '1'));
      tail = work.then(() => undefined, () => undefined);
      return work;
    },
    async isPending(userId: string): Promise<boolean> {
      await tail;
      try {
        return await storage.getItem(ACCOUNT_DELETION_PENDING_PREFIX + userId) !== null;
      } catch {
        // A disk failure cannot authorize restoring/sending potentially deleted data.
        return true;
      }
    },
  };
}

const markers = createAccountDeletionMarkers(AsyncStorage);
export const markAccountDeletionPending = markers.markPending;
export const isAccountDeletionPending = markers.isPending;

interface DeletionCleanupStorage {
  getAllKeys(): Promise<readonly string[]>;
  multiRemove(keys: string[]): Promise<void>;
}

/** Clear this installation after confirmed deletion without unpausing other accounts. */
export async function clearStorageAfterAccountDeletion(
  userId: string,
  isCurrent: () => boolean,
  storage: DeletionCleanupStorage = AsyncStorage,
): Promise<boolean> {
  if (!userId || !isCurrent()) return false;
  const keys = await storage.getAllKeys();
  // A different sign-in can arrive while enumerating disk. Never remove its
  // session or data after this operation loses authentication ownership.
  if (!isCurrent()) return false;
  const ownMarker = ACCOUNT_DELETION_PENDING_PREFIX + userId;
  const removable = keys.filter((key) =>
    !key.startsWith(ACCOUNT_DELETION_PENDING_PREFIX) || key === ownMarker,
  );
  if (removable.length) await storage.multiRemove(removable);
  return isCurrent();
}
