// src/services/supabase.ts
// Supabase client + auth helpers for Nexus
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { publicConfigValue, publicConfigSource } from '../utils/public-config';
import {
  decideOutbound,
  nextWriteToken,
  outboundResult,
  type CloudClock,
  getLastSeenCloudUpdatedAt,
  setLastSeenCloudUpdatedAt,
  sameCloudRevision,
} from './cloud-sync-guard';

// Env first (eas.json profiles / .env at bundle time), app.json `extra`
// fallback (ships in every binary, covers Xcode archives that never see
// eas.json env). See src/utils/public-config.ts.
const SUPABASE_URL = publicConfigValue(
  'EXPO_PUBLIC_SUPABASE_URL',
  process.env.EXPO_PUBLIC_SUPABASE_URL,
);
const SUPABASE_ANON_KEY = publicConfigValue(
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
);

const configured = SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;

export function isSupabaseConfigured(): boolean {
  return configured;
}

if (!configured) {
  // Fail soft: never throw at module evaluation. createClient('') throws
  // "supabaseUrl is required." during bundle eval, which expo-updates
  // ErrorRecovery turns into a launch SIGABRT before first render.
  console.error(
    '[Nexus] Supabase config missing from both env and app.json extra — ' +
    'auth and cloud sync are disabled for this session.',
  );
} else {
  // One-line provenance log: a local .env silently outranks app.json extra
  // in Xcode archives, so record which source actually won.
  console.log(
    '[Nexus] supabase config: url from ' +
    publicConfigSource('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL) +
    ', key from ' +
    publicConfigSource('EXPO_PUBLIC_SUPABASE_ANON_KEY', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY),
  );
}

// When unconfigured, build a real client against a syntactically valid but
// unroutable host (.invalid is reserved, never resolves). Auth/network calls
// return normal supabase error objects that existing call-site try/catches
// already handle, and auth.onAuthStateChange keeps its
// { data: { subscription } } shape — no crash vector at effect time.
export const supabase = createClient(
  configured ? SUPABASE_URL : 'https://unconfigured.invalid',
  configured ? SUPABASE_ANON_KEY : 'unconfigured',
  {
    auth: {
      storage: AsyncStorage as any,
      // Degraded mode: don't run GoTrue's refresh ticker against the
      // unroutable placeholder host forever for a previously persisted session.
      autoRefreshToken: configured,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);

// ─── Auth helpers ────────────────────────────────────────────────────────────

export async function signInWithApple(identityToken: string, nonce: string) {
  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: identityToken,
    nonce,
  });
  if (error) throw error;
  return data;
}

// NEX-328: the old `signOut()` wrapper was deleted — it inherited every SDK
// failure mode (resolves {error} instead of throwing; early-returns without
// _removeSession on a retryable refresh failure). Use hardSignOut from
// src/services/sign-out.ts.

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

// ─── Data sync helpers ───────────────────────────────────────────────────────

// Phase 1 (iPad/desktop): the sync guard makes whole-blob sync
// last-write-wins BY CLOCK. The row's updated_at is compared against the
// last cloud timestamp this device saw (tracked in AsyncStorage by
// cloud-sync-guard.ts); a newer remote row defers the write instead of being
// blindly overwritten. See decideInbound/decideOutbound.

/**
 * FAIL CLOSED. Every outcome that is not "I definitely read this row's clock"
 * is `known: false`, so decideOutbound cannot mistake it for permission to
 * write. `hasBaseline` is needed because PostgREST cannot distinguish "no row"
 * from "a row RLS would not show me" — both come back as zero rows.
 */
async function fetchCloudUpdatedAt(userId: string, hasBaseline: boolean): Promise<CloudClock> {
  try {
    const { data, error } = await supabase
      .from('user_state')
      .select('updated_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      // Logged, not swallowed: a PERSISTENT select failure now defers forever
      // (correctly — but silently, which is its own problem). This is the only
      // breadcrumb that a device has stopped syncing.
      console.warn('[Sync] cloud clock read failed:', error.message ?? error);
      return { known: false };
    }

    if (!data) {
      // Zero rows. Genuinely a new account — UNLESS this device has seen a row
      // before, in which case a row does not simply vanish and the likelier
      // explanations (RLS filtering it, wrong user id) must not authorise
      // overwriting it.
      if (hasBaseline) {
        console.warn('[Sync] cloud row absent despite a local baseline — treating clock as unknown');
        return { known: false };
      }
      return { known: true, updatedAt: null };
    }

    // The row EXISTS. A missing or unparseable updated_at is not "no row" —
    // it is a row whose clock we cannot compare, which is exactly the case
    // that must never resolve to 'write'.
    const raw = data.updated_at;
    if (!raw || !Number.isFinite(Date.parse(raw))) {
      console.warn('[Sync] cloud row has no usable updated_at — treating clock as unknown');
      return { known: false };
    }
    return { known: true, updatedAt: raw };
  } catch (e: any) {
    console.warn('[Sync] cloud clock read threw:', e?.message ?? e);
    return { known: false };
  }
}

/**
 * `status` deliberately separates the two reasons a write does not happen.
 * They demand OPPOSITE responses and collapsing them into one `deferred: true`
 * was a data-loss bug in its own right:
 *
 *   'stale'   — we read the clock and the cloud is genuinely newer. Converging
 *               (pull + force-merge) is correct.
 *   'unknown' — we could not read the clock. Converging would force-merge a
 *               row we equally cannot vouch for OVER newer local state, on the
 *               same reasoning this module uses to refuse the write. Do
 *               nothing and retry.
 */
/**
 * `status` deliberately separates the two reasons a write does not happen.
 * They demand OPPOSITE responses:
 *
 *   'stale'   — the cloud is genuinely newer, or another device won the write
 *               race. Converging (pull + force-merge) is correct.
 *   'unknown' — we could not read the clock. Converging would force-merge a
 *               row we equally cannot vouch for OVER newer local state. Do
 *               nothing and retry.
 *
 * The write itself is a COMPARE-AND-SWAP on `updated_at`. The clock guard
 * above narrows the race; it cannot close it, because the check and the write
 * are separate round trips. Two devices could both read the same clock, both
 * be authorised, and the later `upsert` would silently overwrite the earlier
 * one. The write now only lands if the row is still exactly the version we
 * read, so a loser is TOLD it lost instead of quietly winning.
 *
 * Verified against production before relying on it: no trigger rewrites
 * `updated_at` (the client owns it), it round-trips exactly through JSON, and
 * `user_id` is the primary key (so the insert path conflicts as intended).
 *
 * KNOWN LIMITS OF THIS CAS — it is a real improvement, not a guarantee. Both
 * limits have the same root cause: `updated_at` is a CLIENT-generated
 * timestamp doing the job of a version token. It is neither unique nor
 * server-assigned, and no amount of care here changes that.
 *
 *   1. Two devices that read the same row AND generate the same
 *      millisecond `writtenAt` are not reliably serialised. nextWriteToken
 *      forces the token past the value THIS device read — which fixes the
 *      same-device and clock-skew cases — but it cannot make two independent
 *      clocks disagree. Flagged on PR #468 and left open deliberately.
 *
 *   2. A write that COMMITS but whose response is lost is reported as
 *      'stale'. The caller then converges, and the force-merge can drop
 *      local edits made after the write. Telling a lost response apart from
 *      a lost race requires knowing whether the committed row is OURS, and a
 *      timestamp cannot answer that.
 *
 * An earlier revision tried to close (2) by comparing the row's clock to our
 * own `writtenAt`. It became two P1s: it declared the LOSER the winner
 * whenever two devices produced the same millisecond, and it was skipped on
 * the throwing error path it existed for. Do not reintroduce it. The honest
 * fix for both is a server-assigned, strictly-advancing revision — or a
 * unique per-attempt write token — i.e. a schema change. That was scoped out
 * (owner decision 2026-08-28), not overlooked.
 *
 * The session coordinator owns baseline-aware reconciliation after a lost
 * race. This writer only proves whether this exact network mutation landed.
 */
export interface CloudWriteOptions {
  isCurrent?: () => boolean;
  /** Explicit queued callers reject a snapshot superseded before the write. */
  canWrite?: () => boolean;
  /** The coordinator's exact accepted revision, including known absence. */
  expectedUpdatedAt?: string | null;
  /** Coordinator persists exact payload and clock together. */
  persistClock?: boolean;
}

export async function syncStateToCloud(
  userId: string,
  state: any,
  options: CloudWriteOptions = {},
): Promise<{ status: 'written' | 'stale' | 'unknown'; deferred: boolean; cloudUpdatedAt: string | null }> {
  const isCurrent = options.isCurrent ?? (() => true);
  const canWrite = () => isCurrent() && (options.canWrite?.() ?? true);
  if (!canWrite()) return outboundResult('stale', null);
  const hasExpectedRevision = Object.prototype.hasOwnProperty.call(options, 'expectedUpdatedAt');
  const lastSeen = hasExpectedRevision ? options.expectedUpdatedAt ?? null : await getLastSeenCloudUpdatedAt(userId);
  if (!canWrite()) return outboundResult('stale', null);
  const cloudClock = await fetchCloudUpdatedAt(userId, lastSeen !== null);
  const cloudUpdatedAt = cloudClock.known ? cloudClock.updatedAt : null;
  if (!canWrite()) return outboundResult('stale', cloudUpdatedAt);
  if (hasExpectedRevision && cloudClock.known && !sameCloudRevision(cloudUpdatedAt, lastSeen)) {
    return outboundResult('stale', cloudUpdatedAt);
  }
  if (decideOutbound({ cloudClock, lastSeenUpdatedAt: lastSeen }) === 'defer') {
    return outboundResult(cloudClock.known ? 'stale' : 'unknown', cloudUpdatedAt);
  }

  // The token MUST advance, or the compare-and-swap stops serialising.
  //
  // If the clock returns a value <= the one we read — the same device writing
  // twice inside one millisecond, or backwards clock skew — then the CAS
  // becomes `WHERE updated_at = X` setting `updated_at = X`. The token does
  // not change, so a competing device that also read X still matches X and
  // ALSO succeeds. Both writes land and the second silently overwrites the
  // first: exactly the bug this whole change exists to remove, reintroduced
  // through the token rather than the predicate.
  //
  // Codex flagged this in the plan review ("ensure every successful write
  // changes the CAS token") and I recorded it as residual instead of
  // implementing it. It was not residual; it was a hole in the primary
  // mechanism.
  //
  // Compared numerically, not as strings: PostgREST returns "+00:00" and
  // toISOString() returns "Z", so a lexical compare of the two is wrong.
  const writtenAt = nextWriteToken(new Date().toISOString(), cloudUpdatedAt);

  // No row: plain INSERT. user_id is the primary key, so if another device
  // created the row in the gap this raises 23505 rather than overwriting it.
  if (cloudUpdatedAt === null) {
    if (!canWrite()) return outboundResult('stale', null);
    const { error } = await supabase
      .from('user_state')
      .insert({ user_id: userId, state_data: state, updated_at: writtenAt });
    if (error) {
      if ((error as any).code === '23505') return outboundResult('stale', null);
      throw error;
    }
    if (!isCurrent()) return outboundResult('stale', writtenAt);
    if (options.persistClock !== false) await setLastSeenCloudUpdatedAt(userId, writtenAt, isCurrent);
    return outboundResult(isCurrent() ? 'written' : 'stale', writtenAt);
  }

  // Row exists: conditional UPDATE. `cloudUpdatedAt` is passed VERBATIM — it is
  // the exact string PostgREST returned. Re-serialising it (through new Date(),
  // say) truncates precision and the CAS would never match again, silently
  // wedging every future write into 'stale'.
  if (!canWrite()) return outboundResult('stale', cloudUpdatedAt);
  const { data, error, count } = await supabase
    .from('user_state')
    .update({ state_data: state, updated_at: writtenAt }, { count: 'exact' })
    .eq('user_id', userId)
    .eq('updated_at', cloudUpdatedAt)
    .select('updated_at');
  if (error) throw error;

  // `count: 'exact'` is the primary signal; returned rows are a fallback for a
  // client that does not populate it.
  const matched =
    typeof count === 'number' ? count : ((data as unknown as unknown[] | null)?.length ?? 0);

  // Zero rows matched: we did not win. Report it and let the caller converge.
  //
  // An earlier revision tried to be cleverer here — a "confirm read" to tell a
  // lost race apart from a lost response, plus single-flighting concurrent
  // pushes. Both were added in response to plan review, and BOTH introduced
  // worse bugs than they solved (see the PR): the confirm read misattributed a
  // win whenever two devices produced the same millisecond timestamp, and it
  // was skipped entirely on the very error path it existed for; the
  // single-flight handed a second caller the FIRST caller's result, reporting
  // a snapshot as written that was never sent.
  //
  // So neither is here. Concurrent pushes now simply both run — the CAS
  // serialises them, the loser is told, and no caller is ever told its own
  // state landed when it did not. Doing less is what makes this correct.
  if (matched === 0) return outboundResult('stale', cloudUpdatedAt);

  if (!isCurrent()) return outboundResult('stale', writtenAt);
  if (options.persistClock !== false) await setLastSeenCloudUpdatedAt(userId, writtenAt, isCurrent);
  return outboundResult(isCurrent() ? 'written' : 'stale', writtenAt);
}

export async function loadStateFromCloud(
  userId: string,
): Promise<{ state: any; updatedAt: string | null } | null> {
  const { data, error } = await supabase
    .from('user_state')
    .select('state_data, updated_at')
    .eq('user_id', userId)
    .single();
  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = not found
  if (!data) return null;
  // updated_at used to be selected and discarded; it now feeds the clock
  // guard (decideInbound) and the last-seen record.
  return { state: data.state_data ?? null, updatedAt: data.updated_at ?? null };
}
