// Leaf clock decisions and durable per-user sync metadata.
// The coordinator stores exact accepted payloads beside the legacy scalar
// clock, and preserves conflicting values before merging. Metadata writes and
// sign-out clearing are serialized with ownership epochs. The low-level writer
// still refuses unreadable clocks and uses conditional timestamp updates.
import AsyncStorage from '@react-native-async-storage/async-storage';

const LAST_SEEN_PREFIX = 'nexus.cloudSync.lastSeenUpdatedAt.';
export const CLOUD_SYNC_BASELINE_PREFIX = LAST_SEEN_PREFIX;
export const CLOUD_SYNC_PAYLOAD_BASELINE_PREFIX = 'nexus.cloudSync.accepted.v1.';
export const CLOUD_SYNC_RECOVERY_PREFIX = 'nexus.cloudSync.recovery.v1.';

export interface CloudSyncBaseline {
  version: 1;
  userId: string;
  updatedAt: string;
  /** The remote read or exact sent payload, NEVER the post-merge store. */
  payload: Record<string, any>;
}

export interface CloudSyncRecovery {
  version: 1;
  userId: string;
  capturedAt: string;
  reason: 'unknown-history' | 'conflict';
  base: Record<string, any> | null;
  local: Record<string, any>;
  remote: Record<string, any>;
  conflicts: string[];
}

// All metadata mutations and sign-out clears share a queue. Invalidation
// happens before the first await; an old queued write also carries an epoch
// so it cannot repopulate a namespace after sign-out has cleared it.
let metadataTail: Promise<unknown> = Promise.resolve();
let allUsersEpoch = 0;
let recoveryCounter = 0;
const userEpochs = new Map<string, number>();
const alwaysCurrent = () => true;

function metadataWrite<T>(userId: string, isCurrent: () => boolean, fallback: T, write: () => Promise<T>): Promise<T> {
  const allEpoch = allUsersEpoch;
  const userEpoch = userEpochs.get(userId) ?? 0;
  const work = metadataTail.then(async () => {
    if (!isCurrent() || allEpoch !== allUsersEpoch || userEpoch !== (userEpochs.get(userId) ?? 0)) return fallback;
    try { return await write(); } catch { return fallback; }
  });
  metadataTail = work.then(() => undefined, () => undefined);
  return work;
}

export async function getLastSeenCloudUpdatedAt(userId: string): Promise<string | null> {
  await metadataTail;
  try { return await AsyncStorage.getItem(LAST_SEEN_PREFIX + userId); }
  catch { return null; }
}

export async function setLastSeenCloudUpdatedAt(userId: string, updatedAt: string, isCurrent = alwaysCurrent): Promise<void> {
  await metadataWrite(userId, isCurrent, undefined, async () => {
    await AsyncStorage.setItem(LAST_SEEN_PREFIX + userId, updatedAt);
  });
}

export async function getCloudSyncBaseline(userId: string): Promise<CloudSyncBaseline | null> {
  await metadataTail;
  try {
    const raw = await AsyncStorage.getItem(CLOUD_SYNC_PAYLOAD_BASELINE_PREFIX + userId);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (value?.version !== 1 || value.userId !== userId ||
        typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) ||
        !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) return null;
    return value;
  } catch { return null; }
}

export function setCloudSyncBaseline(baseline: CloudSyncBaseline, isCurrent = alwaysCurrent): Promise<boolean> {
  // Clone before enqueue: callers cannot mutate the acknowledged payload while
  // an earlier storage operation is in flight.
  const serialized = JSON.stringify(baseline);
  return metadataWrite(baseline.userId, isCurrent, false, async () => {
    await AsyncStorage.setItem(CLOUD_SYNC_PAYLOAD_BASELINE_PREFIX + baseline.userId, serialized);
    if (!isCurrent()) return false;
    // Keep the old scalar format readable by a rolled-back app version.
    await AsyncStorage.setItem(LAST_SEEN_PREFIX + baseline.userId, baseline.updatedAt);
    return isCurrent();
  });
}

export function saveCloudSyncRecovery(recovery: CloudSyncRecovery, isCurrent = alwaysCurrent): Promise<boolean> {
  const serialized = JSON.stringify(recovery);
  const key = CLOUD_SYNC_RECOVERY_PREFIX + recovery.userId + '.' + Date.now() + '.' + (++recoveryCounter);
  return metadataWrite(recovery.userId, isCurrent, false, async () => {
    // Each conflict gets an immutable record; a later conflict must never
    // overwrite the only copy of a losing value from an earlier one.
    await AsyncStorage.setItem(key, serialized);
    return isCurrent();
  });
}

interface MetadataClearStorage {
  getAllKeys?(): Promise<readonly string[]>;
  multiRemove(keys: string[]): Promise<void>;
}

export function clearCloudSyncMetadata(userId?: string, storage: MetadataClearStorage = AsyncStorage): Promise<void> {
  if (userId) userEpochs.set(userId, (userEpochs.get(userId) ?? 0) + 1);
  else allUsersEpoch++;
  const work = metadataTail.then(async () => {
    const keys = storage.getAllKeys ? await storage.getAllKeys() : [];
    const relevant = keys.filter((key) => userId
      ? key === LAST_SEEN_PREFIX + userId || key === CLOUD_SYNC_PAYLOAD_BASELINE_PREFIX + userId ||
        key.startsWith(CLOUD_SYNC_RECOVERY_PREFIX + userId + '.')
      : [LAST_SEEN_PREFIX, CLOUD_SYNC_PAYLOAD_BASELINE_PREFIX, CLOUD_SYNC_RECOVERY_PREFIX].some((prefix) => key.startsWith(prefix)));
    if (userId) relevant.push(LAST_SEEN_PREFIX + userId, CLOUD_SYNC_PAYLOAD_BASELINE_PREFIX + userId);
    if (relevant.length) await storage.multiRemove([...new Set(relevant)]);
  });
  metadataTail = work.then(() => undefined, () => undefined);
  return work;
}

/** Equivalent PostgREST ISO spelling, retaining sub-millisecond precision. */
export function sameCloudRevision(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (!a || !b || !Number.isFinite(Date.parse(a)) || !Number.isFinite(Date.parse(b))) return false;
  const fraction = (value: string) => (value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? '').padEnd(9, '0').slice(3);
  return Date.parse(a) === Date.parse(b) && fraction(a) === fraction(b);
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export type InboundDecision = 'merge' | 'keep-local';

// Should an inbound cloud snapshot be applied over the local store?
export function decideInbound(args: {
  cloudUpdatedAt?: string | null;
  lastSeenUpdatedAt?: string | null;
  localIsEmpty: boolean;
}): InboundDecision {
  // NEX-142 seed path, unchanged: an empty install always restores.
  if (args.localIsEmpty) return 'merge';
  const cloud = toMs(args.cloudUpdatedAt);
  const seen = toMs(args.lastSeenUpdatedAt);
  // No trustworthy clock comparison → conservative: local stays canonical
  // (the NEX-142 default for populated installs). This also covers upgrade,
  // where lastSeen does not exist yet.
  if (cloud === null || seen === null) return 'keep-local';
  return cloud > seen ? 'merge' : 'keep-local';
}

export type OutboundDecision = 'write' | 'defer';

/**
 * The result of reading the cloud row's clock.
 *
 * `known: false` — the read FAILED (network, timeout, RLS, auth). This is not
 * the same thing as "there is no row", and conflating the two is a data-loss
 * bug: the previous version returned `null` for both, so a transient read
 * failure looked identical to a virgin account and the guard said "write".
 * A device with partial local state could then blind-upsert over a populated
 * cloud row. The old comment reasoned that "the upsert below would hit the
 * same network fault" — that does not hold: a timed-out SELECT is perfectly
 * capable of being followed by a successful UPSERT.
 *
 * Making the two cases distinct TYPES is the point. "We could not tell" can no
 * longer be silently spelled the same way as "there is nothing there".
 */
export type CloudClock =
  /** Read succeeded. `updatedAt: null` genuinely means no row exists yet. */
  | { known: true; updatedAt: string | null }
  /** Read failed. We know nothing about the cloud row. */
  | { known: false };

// Should this device upsert its state to the cloud row right now?
export function decideOutbound(args: {
  cloudClock: CloudClock;
  lastSeenUpdatedAt?: string | null;
}): OutboundDecision {
  // Unknown clock → never write. We cannot rule out a populated row that is
  // newer than us, and overwriting one is unrecoverable; skipping a sync cycle
  // is not. The caller retries on its next interval.
  if (!args.cloudClock.known) return 'defer';

  const cloud = toMs(args.cloudClock.updatedAt);
  // Genuinely no cloud row → first write.
  if (cloud === null) return 'write';
  const seen = toMs(args.lastSeenUpdatedAt);
  // The row exists but this device has no baseline for it → don't blind-write;
  // the caller establishes the baseline (and converges if newer) first.
  if (seen === null) return 'defer';
  // Someone wrote after our last read/write → we are stale. Deferring is the
  // whole point of the guard: a stale device must not clobber fresher edits.
  return cloud > seen ? 'defer' : 'write';
}

export type OutboundStatus = 'written' | 'stale' | 'unknown';

/**
 * The result contract for an outbound sync attempt.
 *
 * `deferred` is derived, never passed in, because it MUST stay in lockstep
 * with `status`. connector-actions branches on `deferred` (not `status`) to
 * decide whether a queued mutation reached the cloud; a result that said
 * `status: 'stale'` while leaving `deferred: false` would make the drain
 * receipt a mutation that never landed, and other devices would then skip
 * re-applying it. Silent loss, in the one file written to prevent it.
 *
 * Deriving it here means a future status can only ever be added in one place.
 */
export function outboundResult(
  status: OutboundStatus,
  cloudUpdatedAt: string | null,
): { status: OutboundStatus; deferred: boolean; cloudUpdatedAt: string | null } {
  return { status, deferred: status !== 'written', cloudUpdatedAt };
}

/**
 * The `updated_at` value a write should stamp, given the value it is swapping
 * against.
 *
 * The compare-and-swap only serialises writers if the token CHANGES on every
 * successful write. If the clock returns a value <= the one we read — the same
 * device writing twice inside a millisecond, or backwards clock skew — the CAS
 * degenerates to `WHERE updated_at = X` setting `updated_at = X`. A competing
 * device that also read X then still matches X and succeeds too. Both writes
 * land, the second silently overwrites the first, and the guard has done
 * nothing.
 *
 * So the token is forced strictly forward. Ordering is preserved (the value
 * only ever moves up), which matters because decideInbound/decideOutbound
 * compare these same timestamps as clocks.
 *
 * Compared numerically, never lexically: PostgREST returns "+00:00" while
 * toISOString() returns "Z", so a string compare of the two is wrong.
 */
export function nextWriteToken(nowIso: string, baseIso: string | null): string {
  if (baseIso === null) return nowIso;
  const base = Date.parse(baseIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(base)) return nowIso;
  if (!Number.isFinite(now) || now <= base) return new Date(base + 1).toISOString();
  return nowIso;
}
