import AsyncStorage from '@react-native-async-storage/async-storage';
import { PERSIST_STORAGE_KEY, PERSIST_VERSION } from '../state/persistence-keys';

// Latest snapshot — refreshed on every write. Recovers accidental local clears.
export const DURABILITY_BACKUP_KEY = 'nexus-sovereign-storage-backup';
// Pre-migration snapshot — captured at a version boundary, before migrate()
// runs, and never overwritten by the post-migration write. Rolls back a bad update.
export const DURABILITY_SAFE_BACKUP_KEY = 'nexus-sovereign-storage-backup-premigration';

export type DurabilityBackupReason = 'pre_hydration' | 'post_write' | 'manual';

export interface DurabilityBackupEnvelope {
  rawPersistedState: string;
  createdAt: string;
  reason: DurabilityBackupReason;
  persistVersion: number;
  bytes: number;
}

export interface DurabilityBackupStatus {
  isBackedUp: boolean;
  createdAt: string | null;
  reason: DurabilityBackupReason | null;
  persistVersion: number | null;
  bytes: number;
  hasPreMigrationBackup: boolean;
  preMigrationVersion: number | null;
}

function bytesOf(value: string): number {
  if (typeof Blob !== 'undefined') return new Blob([value]).size;
  return value.length;
}

function versionOf(rawPersistedState: string): number | null {
  try {
    const parsed = JSON.parse(rawPersistedState);
    return typeof parsed?.version === 'number' ? parsed.version : null;
  } catch {
    return null;
  }
}

function hasRecoverableUserData(rawPersistedState: string): boolean {
  try {
    const parsed = JSON.parse(rawPersistedState);
    const state = parsed?.state && typeof parsed.state === 'object' ? parsed.state : parsed;
    if (!state || typeof state !== 'object') return false;

    const durableArrays = [
      state.recurringRules,
      state.habitLog,
      state.horizonReviews,
      state.pillars,
      state.inbox,
      state.leadTimeActions, // NEX-162
      state.habits,
      state.completedChallenges,
    ];
    if (durableArrays.some((value) => Array.isArray(value) && value.length > 0)) return true;
    // A coach conversation is user data too (coach plan, S1.6).
    if (Array.isArray(state.coachThread?.messages) && state.coachThread.messages.some((m: any) => m?.role === 'user')) return true;

    const durableObjects = [
      state.dailyTasks,
      state.orbitDays,
      state.dailyScores,
      state.habitStreaks,
      state.scoreHistory,
      state.goalHabitMap,
      state.mandateFocus,
    ];
    if (durableObjects.some((value) => value && typeof value === 'object' && Object.keys(value).length > 0)) return true;

    return state.isActivated === true;
  } catch {
    // If the live payload is malformed, keep the previous known-good backup
    // rather than replacing it with bytes we cannot restore safely.
    return false;
  }
}

function parseEnvelope(raw: string | null): DurabilityBackupEnvelope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.rawPersistedState === 'string' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.bytes === 'number'
    ) {
      return parsed as DurabilityBackupEnvelope;
    }
  } catch {
    // Corrupt backup metadata should not block app startup. The next
    // successful write will replace it with a fresh envelope.
  }
  return null;
}

function buildEnvelope(raw: string, reason: DurabilityBackupReason): DurabilityBackupEnvelope {
  return {
    rawPersistedState: raw,
    createdAt: new Date().toISOString(),
    reason,
    // Actual schema version of THESE bytes, not the running code's constant.
    persistVersion: versionOf(raw) ?? PERSIST_VERSION,
    bytes: bytesOf(raw),
  };
}

export async function recordDurabilityBackupFromRaw(
  rawPersistedState: string,
  reason: DurabilityBackupReason,
): Promise<DurabilityBackupEnvelope> {
  const recoverable = hasRecoverableUserData(rawPersistedState);

  // 1) Latest slot — accidental-clear recovery. Never replace a known-good
  //    backup with empty/malformed bytes.
  const currentLatest = parseEnvelope(await AsyncStorage.getItem(DURABILITY_BACKUP_KEY));
  let latest = currentLatest;
  if (recoverable || !currentLatest) {
    latest = buildEnvelope(rawPersistedState, reason);
    await AsyncStorage.setItem(DURABILITY_BACKUP_KEY, JSON.stringify(latest));
  }

  // 2) Pre-migration slot — bad-update rollback. Captured only at a version
  //    boundary (data on disk is older than the running code's PERSIST_VERSION),
  //    only with recoverable data, and only once per boundary — so the
  //    post-migration write that follows in the same launch cannot reach it.
  if (reason === 'pre_hydration' && recoverable) {
    const v = versionOf(rawPersistedState);
    if (typeof v === 'number' && v < PERSIST_VERSION) {
      const existingSafe = parseEnvelope(await AsyncStorage.getItem(DURABILITY_SAFE_BACKUP_KEY));
      const alreadyCapturedThisBoundary = !!existingSafe && existingSafe.persistVersion >= v;
      if (!alreadyCapturedThisBoundary) {
        await AsyncStorage.setItem(
          DURABILITY_SAFE_BACKUP_KEY,
          JSON.stringify(buildEnvelope(rawPersistedState, 'pre_hydration')),
        );
      }
    }
  }

  return latest ?? buildEnvelope(rawPersistedState, reason);
}

export async function createDurabilityBackup(reason: DurabilityBackupReason = 'manual'):
  Promise<DurabilityBackupEnvelope | null> {
  const raw = await AsyncStorage.getItem(PERSIST_STORAGE_KEY);
  if (!raw) return null;
  return recordDurabilityBackupFromRaw(raw, reason);
}

export async function getDurabilityBackupStatus(): Promise<DurabilityBackupStatus> {
  const [envelope, safe] = await Promise.all([
    AsyncStorage.getItem(DURABILITY_BACKUP_KEY).then(parseEnvelope),
    AsyncStorage.getItem(DURABILITY_SAFE_BACKUP_KEY).then(parseEnvelope),
  ]);

  if (!envelope) {
    return {
      isBackedUp: false,
      createdAt: null,
      reason: null,
      persistVersion: null,
      bytes: 0,
      hasPreMigrationBackup: !!safe,
      preMigrationVersion: safe?.persistVersion ?? null,
    };
  }

  return {
    isBackedUp: true,
    createdAt: envelope.createdAt,
    reason: envelope.reason,
    persistVersion: envelope.persistVersion,
    bytes: envelope.bytes,
    hasPreMigrationBackup: !!safe,
    preMigrationVersion: safe?.persistVersion ?? null,
  };
}

export async function restoreDurabilityBackup(
  source: 'auto' | 'premigration' | 'latest' = 'auto',
): Promise<DurabilityBackupEnvelope> {
  const premigration = parseEnvelope(await AsyncStorage.getItem(DURABILITY_SAFE_BACKUP_KEY));
  const latest = parseEnvelope(await AsyncStorage.getItem(DURABILITY_BACKUP_KEY));

  // auto: bad-update rollback is the headline use case, so prefer the
  // pre-migration snapshot when one exists, then fall back to latest.
  const envelope: DurabilityBackupEnvelope | null =
    source === 'premigration' ? premigration : source === 'latest' ? latest : premigration ?? latest;

  if (!envelope) {
    throw new Error('No Nexus backup was found on this device.');
  }

  // Validate before replacing the live app state. We preserve the exact raw
  // Zustand persist payload so restores can recover from bad migrations as
  // well as accidental local-state clears.
  if (!hasRecoverableUserData(envelope.rawPersistedState)) {
    throw new Error('The backup on this device has no recoverable data.');
  }
  await AsyncStorage.setItem(PERSIST_STORAGE_KEY, envelope.rawPersistedState);
  return envelope;
}
