// src/services/connector-actions.ts
// Drain loop for the connector_actions queue (docs/plans/connector-actions.md).
//
// user_state.state_data is device-authoritative whole-blob LWW sync, so the
// nexus-mcp Worker can't write app state directly. Instead it inserts pending
// rows into public.connector_actions (service role), and the app drains them
// here — through the REAL store actions, so streaks/XP/score side effects
// fire exactly as if the user tapped — then flips each row through the
// apply_connector_action RPC (SECURITY DEFINER; only rows owned by auth.uid()
// transition). Drain order is claim → apply → finalize (see below); a lost
// claim race or a stale un-finalized claim is a skip/reclaim, never a
// duplicate apply.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { supabase } from './supabase';
import { pushCloudSnapshot, requestCloudPull } from './cloud-sync';
import type { SyncSession } from './sync-session';
import { buildCloudSyncPayload } from './cloud-sync-payload';
import { normalize, stripEmoji } from '../utils/text';
import {
  useAppState,
  getLocalDateKey,
  type LogHabitOutcome,
} from '../state/app-state';

// ─── Install-scoped device id ────────────────────────────────────────────────
// Stamped onto applied_by_device_id so a second device can see which install
// applied an action. The repo has no pre-existing install id, so generate one
// and persist it.

const DEVICE_ID_KEY = 'nexus_connector_device_id';
let cachedDeviceId: string | null = null;

export async function getConnectorDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (existing) {
      cachedDeviceId = existing;
      return existing;
    }
  } catch {
    // Storage read failed — fall through and mint an in-memory id for this run.
  }
  const id = Crypto.randomUUID();
  cachedDeviceId = id;
  try {
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    // Persist best-effort; the cached id still keeps this run consistent.
  }
  return id;
}

// ─── Locally-applied action ids ─────────────────────────────────────────────
// Greptile #392 round 3: a stale-claim reclaim must not repeat the local
// mutation. log_habit is timesPerDay-cap-guarded, but inbox tasks, daily
// tasks, and weekly wins are not idempotent — re-applying them duplicates.
// So every row whose applyOne MUTATED the store (status 'applied') is
// recorded here immediately, BEFORE the finalize RPC; a reclaim that finds
// the id in this set skips applyOne and only closes the row out.

const APPLIED_IDS_KEY = 'nexus_connector_applied_ids';
const APPLIED_IDS_CAP = 500; // rolling window; ids are only reclaimed for ~10 min
let cachedAppliedIds: string[] | null = null;

async function loadAppliedIds(): Promise<string[]> {
  if (cachedAppliedIds) return cachedAppliedIds;
  let ids: unknown = [];
  try {
    const raw = await AsyncStorage.getItem(APPLIED_IDS_KEY);
    ids = raw ? JSON.parse(raw) : [];
  } catch {
    ids = [];
  }
  cachedAppliedIds = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
  return cachedAppliedIds;
}

async function recordAppliedId(actionId: string, known: string[]): Promise<string[]> {
  const next = [actionId, ...known.filter((x) => x !== actionId)].slice(0, APPLIED_IDS_CAP);
  cachedAppliedIds = next;
  try {
    await AsyncStorage.setItem(APPLIED_IDS_KEY, JSON.stringify(next));
  } catch {
    // Persist best-effort; the in-memory set still covers this run.
  }
  return next;
}

// ─── Drain ───────────────────────────────────────────────────────────────────

type ConnectorActionRow = {
  id: string;
  action_type: string;
  payload: unknown;
  created_at: string;
  status?: string; // 'pending' or a stale 'claimed' — the fetch only returns those
  // Server-side receipt (migration 20260808020000): true once ANY device has
  // run the store mutation for this row — reclaiming devices must not re-apply.
  local_mutation?: boolean;
};

type TerminalStatus = 'applied' | 'noop' | 'failed';

type ApplyResult = { status: TerminalStatus; outcome: string | null };

const isDateKey = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

// Mandate titles can carry decorative emoji in the app ("📌 Build Wealth")
// while the coach's titles won't. Match on the emoji-stripped normalized
// form so removals and reclaim fingerprints agree (Greptile #403 P1).
const mandateKey = (t: string): string => normalize(stripEmoji(t));

// Apply one row through the store. NEVER throws — a single bad action is
// marked failed and the drain continues with the next row.
function applyOne(row: ConnectorActionRow): ApplyResult {
  try {
    const store = useAppState.getState() as any;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    // The migration comment names the habit payload key `habit_title` while
    // the plan says `title`; accept either so both payload shapes apply.
    const rawTitle = payload.title ?? payload.habit_title;
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    const dateKey = isDateKey(payload.date_key)
      ? payload.date_key
      : getLocalDateKey(new Date());

    switch (row.action_type) {
      case 'add_inbox_task': {
        if (!title) return { status: 'failed', outcome: 'missing_title' };
        store.addInboxTask(title);
        return { status: 'applied', outcome: null };
      }
      case 'log_habit': {
        if (!title) return { status: 'failed', outcome: 'missing_title' };
        if (payload.date_key != null && !isDateKey(payload.date_key)) {
          return { status: 'failed', outcome: 'invalid_date_key' };
        }
        const result: LogHabitOutcome = store.logHabitForDate(title, dateKey);
        if (result === 'applied') return { status: 'applied', outcome: null };
        if (result === 'already_at_times_per_day') {
          return { status: 'noop', outcome: 'already_at_times_per_day' };
        }
        return { status: 'failed', outcome: result };
      }
      case 'append_win': {
        if (!title) return { status: 'failed', outcome: 'missing_title' };
        store.appendWeeklyWin(title);
        return { status: 'applied', outcome: null };
      }
      case 'add_daily_task': {
        if (!title) return { status: 'failed', outcome: 'missing_title' };
        if (payload.date_key != null && !isDateKey(payload.date_key)) {
          return { status: 'failed', outcome: 'invalid_date_key' };
        }
        // addDailyTask(dateKey-sniffing): (title, dateKey) targets the date.
        store.addDailyTask(title, dateKey);
        return { status: 'applied', outcome: null };
      }
      case 'add_mandate': {
        if (!title) return { status: 'failed', outcome: 'missing_title' };
        const category =
          typeof payload.category === 'string' && payload.category.trim()
            ? payload.category.trim()
            : 'BUSINESS';
        // addPillarManual returns the new id — no title read-back race when a
        // same-title pillar already exists.
        const id: string = store.addPillarManual(title, '', category);
        const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
        if (notes) {
          useAppState.getState().updatePillarNotes(id, notes);
        }
        return { status: 'applied', outcome: null };
      }
      case 'remove_mandate': {
        if (!title) return { status: 'failed', outcome: 'missing_title' };
        const match = (useAppState.getState().pillars ?? []).find(
          (p: any) => mandateKey(p.title) === mandateKey(title),
        );
        if (!match) return { status: 'noop', outcome: 'no_matching_mandate' };
        store.deletePillar(match.id);
        return { status: 'applied', outcome: null };
      }
      default:
        return { status: 'failed', outcome: 'unknown_action_type' };
    }
  } catch (e: any) {
    return { status: 'failed', outcome: `exception:${e?.message ?? e}` };
  }
}

// One claim goes stale after this long — a device that died between claim and
// finalize must not strand the row. Mirrors the RPC's 10-minute guard.
const CLAIM_STALE_MS = 10 * 60 * 1000;

type RpcStatus = 'claimed' | TerminalStatus;

async function callApplyRpc(
  actionId: string,
  status: RpcStatus,
  outcome: string | null,
  deviceId: string,
): Promise<boolean | null> {
  try {
    const { data, error } = await supabase.rpc('apply_connector_action', {
      p_action_id: actionId,
      p_status: status,
      p_outcome: outcome,
      p_device_id: deviceId,
    });
    if (error) {
      console.warn('[Connector] apply RPC failed for', actionId, status, error.message);
      return null;
    }
    return data === true;
  } catch (e: any) {
    console.warn('[Connector] apply RPC threw for', actionId, status, e?.message ?? e);
    return null;
  }
}

// Server-side receipt: stamp local_mutation=true (and refresh the staleness
// clock) so a reclaim by ANY device skips the local apply. Returns whether the
// receipt landed — finalize is HARD-GATED on this (Greptile #392 round 6): a
// row that finalizes without its receipt, or stays claimable without it, lets
// another device reclaim and duplicate the mutation. The AsyncStorage id set
// still covers this install while the row awaits its receipt.
async function markLocalMutation(actionId: string, deviceId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('mark_connector_action_local', {
      p_action_id: actionId,
      p_device_id: deviceId,
    });
    if (error) {
      console.warn('[Connector] local-mutation receipt failed for', actionId, error.message);
      return false;
    }
    return data === true;
  } catch (e: any) {
    console.warn('[Connector] local-mutation receipt threw for', actionId, e?.message ?? e);
    return false;
  }
}

// Greptile #392 rounds 7-12 — EFFECT DETECTION for the reclaim path. When a
// reclaimed row's receipts can't prove the mutation landed (or even when they
// can, since round 12), the apply decision is driven by whether the mutation's
// fingerprint is in the LOCAL store — the local store is what this device
// pushes, so convergence under device-authoritative LWW requires the effect
// locally exactly once.
//
// Accepted trade-off (Greptile #392 round 11): a reclaim whose identical
// title (+date) legitimately exists as a SEPARATE user entry is suppressed —
// indistinguishable from a synced duplicate. For a single-daily-driver user,
// a suppressed duplicate-of-a-reclaim is the safer failure than a visible
// double entry. Fresh pending rows never consult fingerprints, so repeated
// same-title captures from the queue always apply.
function effectPresent(store: any, row: ConnectorActionRow): boolean {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const rawTitle = payload.title ?? payload.habit_title;
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (!title) return false;
  const dateKey = isDateKey(payload.date_key)
    ? payload.date_key
    : getLocalDateKey(new Date());
  switch (row.action_type) {
    case 'add_inbox_task':
      // Greptile #392 round 9/10: match ANY item with the normalized title,
      // regardless of age or completed/archived status. The fingerprint is
      // only consulted on the RECLAIM path (fresh pending rows never reach
      // it), so an ancient same-title item can never suppress a genuinely new
      // user action — it can only prevent a duplicate re-apply, which is
      // exactly what we want. A round-9 recency bound was removed for that
      // reason: an old applied-but-unreceipted task must still dedupe.
      return (store.inbox ?? []).some(
        (t: any) => normalize(t.title) === normalize(title),
      );
    case 'add_daily_task':
      return (store.dailyTasks?.[dateKey] ?? []).some(
        (t: any) => normalize(t.title) === normalize(title),
      );
    case 'append_win':
      return (store.weeklyWins ?? []).some(
        (w: any) => String(w).trim() === title,
      );
    case 'log_habit':
      // Redundant with the timesPerDay cap (which yields noop) — included for
      // consistency so every action type has a fingerprint.
      return (store.habitLog ?? []).some(
        (e: any) =>
          normalize(e.habitTitle) === normalize(title) && e.dateKey === dateKey,
      );
    case 'add_mandate':
      return (store.pillars ?? []).some(
        (p: any) => mandateKey(p.title) === mandateKey(title),
      );
    case 'remove_mandate':
      // The effect of a removal is ABSENCE — a reclaim re-applies only when
      // the mandate is still there to remove.
      return !(store.pillars ?? []).some(
        (p: any) => mandateKey(p.title) === mandateKey(title),
      );
    default:
      return false;
  }
}

// Greptile #392 round 2: defense in depth for backdated habit logs: drain
// log_habit actions oldest-date-first so a queued newer completion can't
// establish the streak anchor before an older one lands. Only the log_habit
// subset is reordered — every other action keeps its created_at position.
// (The store-side backfill guard in buildHabitLogPatch is the primary fix.)
function orderForDrain(rows: ConnectorActionRow[]): ConnectorActionRow[] {
  const dateKeyOf = (r: ConnectorActionRow): string => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    return typeof p.date_key === 'string' ? p.date_key : '9999-12-31';
  };
  const habitPositions: number[] = [];
  const habits: ConnectorActionRow[] = [];
  rows.forEach((r, i) => {
    if (r.action_type === 'log_habit') {
      habitPositions.push(i);
      habits.push(r);
    }
  });
  if (habits.length < 2) return rows;
  habits.sort(
    (a, b) =>
      dateKeyOf(a).localeCompare(dateKeyOf(b)) ||
      a.created_at.localeCompare(b.created_at),
  );
  const out = [...rows];
  habitPositions.forEach((pos, j) => {
    out[pos] = habits[j];
  });
  return out;
}

// Fetch drainable rows for the user and apply each in created_at order, using
// the NEX-185 reserve model so a lost race never duplicates a local apply:
//
//   1. CLAIM   pending → claimed (stamps this device). False/error → another
//              device owns the row; skip WITHOUT touching the store.
//   2. APPLY   run the store actions locally (never throws per row). On
//              RECLAIMS the apply decision is driven by the local effect
//              fingerprint alone (round 12: the local store is what this
//              device pushes, so convergence needs the effect locally exactly
//              once; receipts no longer skip the apply). On FRESH rows a
//              receipt (server local_mutation or the persisted id set) skips
//              it. Successful applies are recorded in the id set immediately.
//   3. PUSH    if anything was applied (or awaits close-out), push the
//              whole-state blob FIRST — a server receipt must mean "applied
//              AND synced" (Greptile #392 round 5: receipting before the
//              mutation reaches user_state lets other devices skip re-applying
//              a change that never synced → silently lost). Push failure →
//              skip receipts AND finalizes; rows stay claimed for reclaim.
//   4. RECEIPT + FINALIZE  per mutated row: mark_connector_action_local, then
//              claimed → applied | noop | failed. The receipt HARD-GATES
//              finalize (a failed receipt leaves the row claimed for reclaim,
//              never finalizable-without-receipt). Rows with no mutation
//              (noop/failed) need no receipt.
//
// Best-effort end to end: a fetch/RPC/push failure just means the rows stay
// drainable for the next tick. Returns per-status counts (for logs).
export async function drainConnectorActions(
  session: SyncSession,
  deviceId: string,
): Promise<{ applied: number; noop: number; failed: number }> {
  const counts = { applied: 0, noop: 0, failed: 0 };
  if (!session.isCurrent()) return counts;
  const userId = session.userId;

  // Pending rows, plus stale claims this or another device never finalized
  // (applied_at doubles as the claim timestamp while status = 'claimed').
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data, error } = await supabase
    .from('connector_actions')
    .select('id, action_type, payload, created_at, status, local_mutation')
    .eq('user_id', userId)
    .or(
      `status.eq.pending,` +
      `and(status.eq.claimed,applied_at.lt.${staleBefore})`,
    )
    .order('created_at', { ascending: true });
  if (!session.isCurrent()) return counts;
  if (error) {
    console.warn('[Connector] pending-action fetch failed:', error.message);
    return counts;
  }
  if (!data || data.length === 0) return counts;

  type PendingClose = {
    row: ConnectorActionRow;
    status: TerminalStatus;
    outcome: string | null;
    // no server-side local_mutation receipt yet — finalize is hard-gated on
    // stamping it (true for newly-applied rows, and for already-applied
    // close-outs whose earlier receipt attempt never landed)
    needsReceipt: boolean;
    // a mutation exists in local state for this row (newly applied OR an
    // already-applied close-out) — finalize only after a successful push
    needsSync: boolean;
  };
  const toClose: PendingClose[] = [];

  let appliedIds = await loadAppliedIds();
  if (!session.isCurrent()) return counts;
  for (const row of orderForDrain(data as ConnectorActionRow[])) {
    if (!session.isCurrent()) return counts;
    // 1. Claim BEFORE any local mutation (Greptile P1: under the old
    //    apply-then-mark order, a false/error RPC left the local apply
    //    orphaned and the row pending, so the next drain applied it again).
    //    fetchedStatus is the QUEUED status ('pending' vs a stale 'claimed'
    //    reclaim) — captured before the claim RPC transitions the row.
    const fetchedStatus = row.status;
    const claimed = await callApplyRpc(row.id, 'claimed', null, deviceId);
    if (!session.isCurrent()) return counts;
    if (claimed !== true) continue; // another device holds a fresh claim

    if (fetchedStatus === 'claimed') {
      // 2b. RECLAIM. The apply decision is driven by the LOCAL fingerprint
      //     alone (Greptile #392 round 12): the local store is what this
      //     device pushes, so convergence under device-authoritative LWW
      //     requires the effect LOCALLY exactly once. Receipts (server
      //     local_mutation, the AsyncStorage id set) no longer skip the
      //     apply — a receipted close-out on a device lacking the effect
      //     would let its next whole-blob push erase the effect everywhere.
      //     Receipts now only drive the finalize path (needsReceipt) and the
      //     push skip: the immediate push is skipped only when the effect was
      //     already synced by someone else (a receipt) AND we did not just
      //     mutate locally; a local apply always pushes.
      if (!effectPresent(useAppState.getState(), row)) {
        if (row.action_type === 'append_win') {
          // weeklyWins is week-scoped — the store keeps ONE week (no
          // history), so a win applied+synced in a PRIOR week but never
          // finalized can't be fingerprinted, and applying it now would land
          // it in the wrong week anyway. A prior-week append_win reclaim
          // closes as expired instead of duplicating. (created_at is UTC, the
          // week key is local — a few-hours edge at the week boundary is
          // acceptable for a guard this deep in the reclaim path.)
          const sunday = new Date();
          sunday.setDate(sunday.getDate() - sunday.getDay());
          if (String(row.created_at ?? '').slice(0, 10) < getLocalDateKey(sunday)) {
            toClose.push({
              row,
              status: 'noop',
              outcome: 'expired_prior_week',
              needsReceipt: false,
              needsSync: false,
            });
            continue;
          }
        }
        // 2c. Local miss → apply locally (convergence), receipted or not.
        if (!session.isCurrent()) return counts;
        const result = applyOne(row);
        if (result.status === 'applied') {
          appliedIds = await recordAppliedId(row.id, appliedIds);
          if (!session.isCurrent()) return counts;
        }
        toClose.push({
          row,
          status: result.status,
          outcome: result.outcome,
          needsReceipt: result.status === 'applied' && row.local_mutation !== true,
          needsSync: result.status === 'applied', // local apply always pushes
        });
        continue;
      }
      // 2d. Local hit → the effect is already in what this device pushes.
      //     Skip the apply; push only if no receipt proves it synced.
      toClose.push({
        row,
        status: 'applied',
        outcome: 'already_applied_locally',
        needsReceipt: row.local_mutation !== true,
        needsSync: row.local_mutation !== true,
      });
      continue;
    }

    if (row.local_mutation === true || appliedIds.includes(row.id)) {
      // 2e. FRESH row with a receipt: the mutation already happened — on ANY
      //     device (server receipt) or this install (id set fast path).
      //     applyOne is NOT idempotent for inbox tasks / daily tasks / wins,
      //     so skip it and just close out. A missing server receipt (earlier
      //     receipt attempt failed) still has to be stamped before finalize.
      toClose.push({
        row,
        status: 'applied',
        outcome: 'already_applied_locally',
        needsReceipt: row.local_mutation !== true,
        needsSync: true,
      });
      continue;
    }

    // 2f. Fresh pending row: apply locally (never throws; a bad row comes
    //     back as failed), and record the id immediately so a later reclaim
    //     never re-applies.
    if (!session.isCurrent()) return counts;
    const result = applyOne(row);
    if (result.status === 'applied') {
      appliedIds = await recordAppliedId(row.id, appliedIds);
      if (!session.isCurrent()) return counts;
    }
    toClose.push({ row, status: result.status, outcome: result.outcome, needsReceipt: result.status === 'applied', needsSync: result.status === 'applied' });
  }
  if (!session.isCurrent() || toClose.length === 0) return counts;

  // 3. Push the whole-state blob BEFORE acknowledging any mutation
  //    server-side. noop/failed rows carry no mutation — they finalize
  //    regardless of the push outcome. Cloud-hit close-outs are synced by
  //    definition — they skip the push but still need the receipt gate.
  const syncRows = toClose.filter((c) => c.needsSync);
  const receiptOnlyRows = toClose.filter((c) => !c.needsSync && c.needsReceipt);
  const plainRows = toClose.filter((c) => !c.needsSync && !c.needsReceipt);
  let pushed = syncRows.length === 0;
  if (syncRows.length > 0) {
    try {
      // Only this immutable, exact snapshot can acknowledge these mutations.
      // A queued snapshot superseded by reconciliation is explicitly deferred.
      const result = await pushCloudSnapshot(session, buildCloudSyncPayload(useAppState.getState()));
      if (!session.isCurrent()) return counts;
      pushed = result?.status === 'written';
      if (!pushed && result?.status === 'stale') {
        await requestCloudPull(session);
        if (!session.isCurrent()) return counts;
      }
    } catch (e: any) {
      // Leave the mutated rows claimed: a later drain reclaims them, and the
      // id set / receipt makes that reclaim a close-out, not a re-apply.
      console.warn('[Connector] post-apply push failed; rows stay claimed for reclaim:', e?.message ?? e);
    }
  }

  // 4. Receipt then finalize. The receipt is a HARD GATE: no
  //    local_mutation=true on the server, no finalize — the row stays claimed
  //    and the reclaim path re-pushes and retries the receipt (the id set
  //    prevents a same-device re-apply meanwhile).
  for (const { row, status, outcome } of plainRows) {
    if (!session.isCurrent()) return counts;
    const finalized = await callApplyRpc(row.id, status, outcome, deviceId);
    if (!session.isCurrent()) return counts;
    if (finalized === true) counts[status] += 1;
  }
  if (!pushed) return counts; // syncRows stay claimed for reclaim
  for (const { row, status, outcome, needsReceipt } of [...syncRows, ...receiptOnlyRows]) {
    if (!session.isCurrent()) return counts;
    if (needsReceipt) {
      const receipted = await markLocalMutation(row.id, deviceId);
      if (!session.isCurrent()) return counts;
      if (!receipted) continue;
    }
    const finalized = await callApplyRpc(row.id, status, outcome, deviceId);
    if (!session.isCurrent()) return counts;
    if (finalized === true) counts[status] += 1;
  }
  return counts;
}
