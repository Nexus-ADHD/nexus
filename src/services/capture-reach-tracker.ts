/**
 * capture-reach-tracker.ts — NEX-261 (ADHD Pivot P4, L-4b)
 *
 * The TRUE-FIRST source of record for `captured_item_first_reached`. NEX-215's
 * `name|capture_id` PostHog seed keeps the first-INGESTED row (send-order), which
 * is wrong when a surfaced reach and a manual reach race. This device-local
 * tracker makes "emit exactly once per capture, on the genuine first reach, with
 * the true access_method" correct across all reach sites and orderings.
 *
 * Model: an insertion-ordered Map<captureId, reached> persisted to one AsyncStorage
 * key (NOT the zustand store / cloud sync — capture_ids are globally-unique uuids,
 * so a stale entry is harmless and there is no cross-account collision; this
 * sidesteps the persisted-store 8-site checklist).
 *
 * - `recordCapture(id)` runs at the `item_captured` emit (BOTH the command and the
 *   home-quick-add sites). It marks which ids are captures so `manual_nav` can fire
 *   only for real captures. It is intentionally NOT wired to the Inbox typed-add
 *   (`handleManualAdd`), which does not emit `item_captured` — wiring it there would
 *   turn a typed item's later interaction into a bogus `manual_nav` hunt.
 * - `recordFirstReach(id, …)` runs at every reach site (the two surfaced ones plus
 *   the manual_nav interaction site). It emits once, on the first reach.
 *
 * Async-claim safety (the NEX-193 race): both entry points `await ensureLoaded()`
 * FIRST, then check+claim SYNCHRONOUSLY (no `await` between the read and the
 * `set`). JS is single-threaded, so two concurrent reaches resume in order — the
 * first claims `reached=true`, the second sees it and no-ops. A capture recorded in
 * a prior session is present in the loaded map, so its reach is never dropped.
 *
 * The `name|capture_id` PostHog seed STAYS and composes: this tracker enforces
 * per-device first-reach; the seed collapses any cross-device / reinstall re-emit
 * (tracker wiped) against the original in PostHog. No double-count.
 *
 * Pure-ish: imports only AsyncStorage + the analytics emit, so vitest covers it
 * with both mocked (mirrors funnel-analytics.test.ts).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { emitCapturedItemFirstReached } from './analytics';
import type { CaptureSurface } from '../features/command/confirmation-copy';
import type { AccessMethod } from './north-star-metrics';

const STORAGE_KEY = 'nexus_capture_reach_v1';

/**
 * Cap on tracked captures. Small (opaque id + bool) so this is generous — sized so
 * realistic capture volume does not evict within the reach horizon. Eviction
 * prefers the oldest REACHED entry (its only job was dedup, which the PostHog seed
 * also covers), keeping the un-reached — and therefore hunt-heavy — tail. Naive
 * evict-oldest would drop the slowest-to-find captures and bias the hunt rate DOWN.
 */
const MAX_ENTRIES = 2000;

let map: Map<string, boolean> | null = null;
let loadPromise: Promise<Map<string, boolean>> | null = null;

function ensureLoaded(): Promise<Map<string, boolean>> {
  if (map) return Promise.resolve(map);
  if (!loadPromise) {
    loadPromise = (async () => {
      let loaded = new Map<string, boolean>();
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            loaded = new Map(
              parsed.filter(
                (e: unknown): e is [string, boolean] =>
                  Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'boolean',
              ),
            );
          }
        }
      } catch {
        // Corrupt/absent → start empty. Re-emits are deduped by the PostHog seed.
      }
      map = loaded;
      return loaded;
    })();
  }
  return loadPromise;
}

// Persist writes the FULL in-memory map each call, so concurrent persists are
// last-writer-wins on identical-enough state (no read-modify-write race like the
// analytics event log). Fire-and-forget; the in-memory map is authoritative.
function persist(): void {
  const m = map;
  if (!m) return;
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...m.entries()])).catch(() => {});
}

function evictIfNeeded(m: Map<string, boolean>): void {
  while (m.size > MAX_ENTRIES) {
    // Oldest reached entry (Map iterates in insertion order). Updating a value via
    // `set` on an existing key does NOT change its position, so a reached entry
    // keeps its original (old) slot — exactly what reached-first eviction wants.
    let evictKey: string | undefined;
    for (const [k, reached] of m) {
      if (reached) {
        evictKey = k;
        break;
      }
    }
    if (evictKey === undefined) {
      // All un-reached: fall back to the oldest overall.
      evictKey = m.keys().next().value as string | undefined;
    }
    if (evictKey === undefined) break;
    m.delete(evictKey);
  }
}

/** Mark `captureId` as a known capture (called at the `item_captured` emit). */
export async function recordCapture(captureId: string): Promise<void> {
  if (!captureId) return;
  const m = await ensureLoaded();
  if (m.has(captureId)) return; // keep the original reached state + position
  m.set(captureId, false);
  evictIfNeeded(m);
  persist();
}

/**
 * Emit `captured_item_first_reached` once, on the genuine first reach of a known
 * capture. No-op for unknown ids (not a capture) or already-reached. Returns
 * whether it emitted.
 */
export async function recordFirstReach(
  captureId: string,
  args: { surface: CaptureSurface; accessMethod: AccessMethod; capturedAtMs?: number | null },
): Promise<boolean> {
  if (!captureId) return false;
  const m = await ensureLoaded();
  // Check + claim synchronously — no `await` between, so concurrent calls can't
  // both pass the gate (single-threaded resume order).
  if (!m.has(captureId)) return false; // not a known capture
  if (m.get(captureId) === true) return false; // already first-reached
  m.set(captureId, true);
  // Emit BEFORE persisting the reached flag. The synchronous claim above already
  // prevents concurrent double-emit; persisting AFTER the emit makes the kill
  // window SAFE: if the app dies after emit but before persist, next launch sees
  // reached=false → re-emits → the name|capture_id PostHog seed dedups it (so at
  // most one row lands). The inverse order (persist first) would silently DROP the
  // event on a kill between the fast local persist and a not-yet-delivered emit —
  // the tracker would already read reached=true and never re-attempt. `finally`
  // persists even if the emit rejects.
  try {
    await emitCapturedItemFirstReached({
      captureId,
      surface: args.surface,
      accessMethod: args.accessMethod,
      capturedAtMs: args.capturedAtMs ?? undefined,
    });
  } finally {
    persist();
  }
  return true;
}
