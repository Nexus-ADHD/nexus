/**
 * Device-local map of recurring-rule id -> Apple Calendar EventKit identifier.
 *
 * WHY THIS IS NOT IN THE SYNCED RULE.
 *
 * EventKit identifiers are local to the device that created them: the same
 * calendar event has a different identifier on every device. `recurringRules`
 * syncs through the cloud, so ANY design that keeps such an identifier on the
 * rule has to defend against the sync layer, and every variant leaks:
 *
 *  - One shared `appleEventId`: device B resolves A's identifier to nothing,
 *    reads that as "the user deleted this event", and deletes the routine —
 *    then the deletion syncs back and removes it from A too. (The original
 *    bug this PR exists to fix.)
 *  - A per-device map on the rule: B stops deleting, but `mergeCloudState`
 *    replaces `recurringRules` wholesale, so a write from a stale snapshot
 *    drops A's entry.
 *  - Union-merging that map on convergence: now an entry RELEASED by an undo
 *    is resurrected from the cloud copy, pointing at an event that was just
 *    deleted — which the next reconcile reads as a user deletion and removes
 *    the routine. Strictly worse than the problem it solves.
 *
 * The identifier is device-local data, so it lives in device-local storage and
 * never enters the payload. Sync cannot drop it, resurrect it, or hand it to a
 * device it does not belong to, and no merge logic is required.
 *
 * `appleEventId` remains on the rule as a compatibility mirror for rendering
 * and for adoption of pre-existing links (see resolveLink). Reconciliation
 * trusts only this store.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'nexus_apple_event_links';

// Durable, disk-backed view. Null until hydrated.
let cache: Record<string, string> | null = null;
let hydrating: Promise<Record<string, string>> | null = null;

/**
 * Writes made THIS session, applied synchronously so a read never lags a
 * write. `null` marks a release.
 *
 * Without this, `setAppleLink` only became visible after its async persist
 * resolved, so an accept immediately followed by an undo could read no link
 * (orphaning the new event) or a stale one (deleting the wrong event). Making
 * every caller await was the alternative; this fixes it once, at the source,
 * and cannot be forgotten at a future call site.
 *
 * Overlay wins over `cache` on read, and is folded into it on persist and on
 * hydrate — an in-memory write is always newer than what is on disk.
 */
const pending: Record<string, string | null> = {};

async function readFromDisk(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Drop anything that isn't a string->string pair rather than trusting the blob.
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([k, v]) => typeof k === 'string' && typeof v === 'string' && k && v
      )
    ) as Record<string, string>;
  } catch {
    // Unreadable storage degrades to "no links", which makes every reconcile
    // decision 'skip'. Never to a destructive branch.
    return {};
  }
}

/** Load the map once per session. Safe to call concurrently. */
export async function hydrateAppleLinks(): Promise<Record<string, string>> {
  if (cache) return snapshot();
  if (!hydrating) {
    hydrating = readFromDisk().then((loaded) => {
      // Disk goes UNDER this session's writes — never over them.
      cache = loaded;
      hydrating = null;
      return loaded;
    });
  }
  await hydrating;
  return snapshot();
}

/** cache with this session's writes applied. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = { ...(cache ?? {}) };
  for (const [k, v] of Object.entries(pending)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/**
 * All mutations run one at a time.
 *
 * Without this, two writes racing before the first hydration both resolve
 * `cache ?? await hydrateAppleLinks()` to the same snapshot, and the second
 * persist drops the first link. That is not theoretical on startup: the
 * reconcile links several rules in the same pass. Losing a link is not
 * destructive (it degrades to 'no link' -> skip) but it silently disables
 * deletion-detection for that rule until a later pass re-links it.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(op: () => Promise<T>): Promise<T> {
  // .then(op, op) so one rejected write cannot wedge the queue.
  const run = writeQueue.then(op, op);
  writeQueue = run.catch(() => undefined);
  return run;
}

async function persist(next: Record<string, string>): Promise<void> {
  cache = next;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort; the in-memory cache keeps this session consistent, and a
    // lost write only costs a re-link on the next pass.
  }
}

/**
 * This device's identifier for a rule, or null. Synchronous — returns null
 * until hydrateAppleLinks() has resolved, which callers must treat as "no
 * link" (i.e. do nothing), never as "the event is gone".
 */
export function getAppleLink(ruleId: string): string | null {
  // This session's writes first — they are visible the instant they are made.
  if (ruleId in pending) return pending[ruleId];
  return (cache && cache[ruleId]) || null;
}

export async function setAppleLink(ruleId: string, eventId: string): Promise<void> {
  if (!ruleId || !eventId) return;
  // Visible to readers immediately, before any await.
  pending[ruleId] = eventId;
  return serialize(async () => {
    if (!cache) await hydrateAppleLinks();
    await persist(snapshot());
  });
}

/** Release this device's link, keeping the rule itself untouched. */
export async function clearAppleLink(ruleId: string): Promise<void> {
  if (!ruleId) return;
  // Visible to readers immediately, before any await.
  pending[ruleId] = null;
  return serialize(async () => {
    if (!cache) await hydrateAppleLinks();
    await persist(snapshot());
  });
}

/** Test seam. */
export function __resetAppleLinksForTest(seed?: Record<string, string>): void {
  cache = seed ? { ...seed } : null;
  hydrating = null;
  writeQueue = Promise.resolve();
  for (const k of Object.keys(pending)) delete pending[k];
}
