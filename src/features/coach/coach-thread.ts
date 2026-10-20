/**
 * coach-thread.ts — the coach conversation's state, as pure data + reducers.
 *
 * RN-free and store-free so vitest covers every transition
 * (docs/plans/2026-09-02-coach-conversation.md, scenarios S1.4, S1.5, S1.6,
 * S2.5, S3.2). `app-state.ts` holds ONE `coachThread` and calls these; the
 * screen never mutates the thread directly.
 *
 * Three decisions the Spec critique forced, encoded here rather than in the
 * screen so they cannot be forgotten by a future caller:
 *
 *   - Clearing is a tombstone (`clearedAt`), never an empty array. The cloud
 *     merge (`mergeCoachThreads`) keeps whichever side is newer by comparing a
 *     clear against the newest message, so a Clear on one device wins on the
 *     other and an empty fresh-device thread never wipes a real one (the
 *     empty-collection guard that protects `inbox` would otherwise resurrect
 *     a cleared thread).
 *   - Applying a plan is recorded BEFORE writing (`applyingAt`) and the plan
 *     is dropped only after the executor returns. A plan restored with
 *     `applyingAt` set is never offered again.
 *   - The opener is keyed by day so a re-open does not regenerate it.
 */

import type { ProposedAction } from '../command/command-types';

export const COACH_THREAD_CAP = 60;
export const COACH_CONTEXT_MESSAGES = 12;

export type CoachRole = 'user' | 'coach';

export type CoachMessageKind =
  /** An ordinary turn. */
  | 'turn'
  /** The first line of the day, written from the person's own data. */
  | 'opener'
  /** The fixed safety hand-off line (classifySafety hit). */
  | 'handoff'
  /** A note the thread writes itself, e.g. "That plan went to Home." */
  | 'note';

export interface CoachMessage {
  id: string;
  role: CoachRole;
  text: string;
  /** Epoch ms. */
  at: number;
  kind: CoachMessageKind;
}

export interface CoachPendingPlan {
  /** getProposalExecutionKey(actions): stable identity for dedupe + restore. */
  proposalKey: string;
  actions: ProposedAction[];
  /** Whether any action is a calendar_add (the confirmation says it stays). */
  hasCalendar: boolean;
  createdAt: number;
  /** Stamped before executeActions runs; null until then. */
  applyingAt: number | null;
}

export interface CoachOpener {
  text: string;
  /** Local YYYY-MM-DD the opener was written for. */
  dayKey: string;
  /** Epoch ms it was stored; the clear tombstone prunes an older one. 0 when unknown. */
  at?: number;
}

export interface CoachThread {
  messages: CoachMessage[];
  pendingPlan: CoachPendingPlan | null;
  pendingOpener: CoachOpener | null;
  /** Tombstone: epoch ms of the last Clear conversation, or null. */
  clearedAt: number | null;
  /**
   * Spoken replies (expo-speech). ON by default: the founder asked for a
   * coach you talk WITH, and a thread you speak into that answers in text
   * only is half a conversation. The toggle on the screen turns it off.
   */
  speakReplies: boolean;
}

export function emptyCoachThread(): CoachThread {
  return { messages: [], pendingPlan: null, pendingOpener: null, clearedAt: null, speakReplies: true };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function sanitizeMessage(raw: unknown): CoachMessage | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  const role = raw.role === 'user' || raw.role === 'coach' ? raw.role : null;
  const text = typeof raw.text === 'string' ? raw.text : null;
  const at = finiteOrNull(raw.at);
  if (!id || !role || text === null || at === null) return null;
  const kind: CoachMessageKind =
    raw.kind === 'opener' || raw.kind === 'handoff' || raw.kind === 'note' ? raw.kind : 'turn';
  return { id, role, text, at, kind };
}

function sanitizePlan(raw: unknown): CoachPendingPlan | null {
  if (!isRecord(raw)) return null;
  const proposalKey = typeof raw.proposalKey === 'string' && raw.proposalKey ? raw.proposalKey : null;
  const actions = Array.isArray(raw.actions)
    ? (raw.actions.filter((a) => isRecord(a) && typeof a.type === 'string' && typeof a.title === 'string') as unknown as ProposedAction[])
    : [];
  const createdAt = finiteOrNull(raw.createdAt);
  if (!proposalKey || actions.length === 0 || createdAt === null) return null;
  return {
    proposalKey,
    actions,
    hasCalendar: raw.hasCalendar === true || actions.some((a) => a.type === 'calendar_add'),
    createdAt,
    applyingAt: finiteOrNull(raw.applyingAt),
  };
}

/**
 * Coerce anything (a persisted blob, an inbound cloud value, undefined) into a
 * well-formed thread. Every field is validated; nothing throws. Used by
 * `migrate()`, `mergeCloudState`, and the initial hydrate.
 */
export function sanitizeCoachThread(raw: unknown): CoachThread {
  if (!isRecord(raw)) return emptyCoachThread();
  const seen = new Set<string>();
  const messages: CoachMessage[] = [];
  for (const m of Array.isArray(raw.messages) ? raw.messages : []) {
    const msg = sanitizeMessage(m);
    if (!msg || seen.has(msg.id)) continue;
    seen.add(msg.id);
    messages.push(msg);
  }
  messages.sort((a, b) => a.at - b.at);
  const opener = isRecord(raw.pendingOpener)
    && typeof raw.pendingOpener.text === 'string'
    && typeof raw.pendingOpener.dayKey === 'string'
    ? { text: raw.pendingOpener.text, dayKey: raw.pendingOpener.dayKey, at: finiteOrNull(raw.pendingOpener.at) ?? 0 }
    : null;
  return {
    messages: messages.slice(-COACH_THREAD_CAP),
    pendingPlan: sanitizePlan(raw.pendingPlan),
    pendingOpener: opener,
    clearedAt: finiteOrNull(raw.clearedAt),
    // Default on; an explicit false is the person's choice and is honoured
    // on every write (this runs inside setCoachThread, so it must not undo a
    // toggle). No migration lifts an old false: builds 255/256 wrote false as
    // their default, but a persisted false on an empty or cleared thread is
    // indistinguishable from a choice, and a preference is never overwritten
    // on a guess (Greptile T-Rex, PR #488). Those installs tap the speaker once.
    speakReplies: raw.speakReplies !== false,
  };
}

/** Epoch ms of the newest message, or 0 for an empty thread. */
export function newestMessageAt(thread: CoachThread): number {
  let max = 0;
  for (const m of thread.messages) if (m.at > max) max = m.at;
  return max;
}

/** True when there is nothing a person would miss: no messages, no plan. */
export function isCoachThreadEmpty(thread: CoachThread): boolean {
  return thread.messages.length === 0 && thread.pendingPlan === null;
}

/** Append and cap to the newest COACH_THREAD_CAP; the pending plan survives. */
export function appendMessage(thread: CoachThread, message: CoachMessage): CoachThread {
  const messages = [...thread.messages.filter((m) => m.id !== message.id), message];
  return { ...thread, messages: messages.slice(-COACH_THREAD_CAP) };
}

/** The messages a model turn is built from: the newest COACH_CONTEXT_MESSAGES turns. */
export function contextMessages(thread: CoachThread): CoachMessage[] {
  return thread.messages.slice(-COACH_CONTEXT_MESSAGES);
}

export function setPendingPlan(thread: CoachThread, plan: CoachPendingPlan | null): CoachThread {
  return { ...thread, pendingPlan: plan };
}

/**
 * Stamp the plan as applying. Returns the thread unchanged when there is no
 * plan or it is already applying, so a double tap cannot re-stamp.
 */
export function markPlanApplying(thread: CoachThread, at: number): CoachThread {
  if (!thread.pendingPlan || thread.pendingPlan.applyingAt !== null) return thread;
  return { ...thread, pendingPlan: { ...thread.pendingPlan, applyingAt: at } };
}

/** Undo markPlanApplying when the executor ran nothing (its lock or dedupe bailed). */
export function unmarkPlanApplying(thread: CoachThread): CoachThread {
  if (!thread.pendingPlan || thread.pendingPlan.applyingAt === null) return thread;
  return { ...thread, pendingPlan: { ...thread.pendingPlan, applyingAt: null } };
}

export function clearPendingPlan(thread: CoachThread): CoachThread {
  return thread.pendingPlan ? { ...thread, pendingPlan: null } : thread;
}

/**
 * A plan that was applying when the app died must not be offered again
 * (S2.5): the executor may have written some or all of it. The screen shows
 * a note with a Jump instead. Returns the plan that was dropped, if any.
 */
export function dropStalePlanOnRestore(thread: CoachThread): { thread: CoachThread; dropped: CoachPendingPlan | null } {
  const plan = thread.pendingPlan;
  if (plan && plan.applyingAt !== null) return { thread: { ...thread, pendingPlan: null }, dropped: plan };
  return { thread, dropped: null };
}

/** Clear conversation: everything goes, and the tombstone is set. */
export function clearThread(thread: CoachThread, at: number): CoachThread {
  return { ...emptyCoachThread(), speakReplies: thread.speakReplies, clearedAt: at };
}

export function setOpener(thread: CoachThread, opener: CoachOpener | null): CoachThread {
  return { ...thread, pendingOpener: opener };
}

/** The stored opener if it was written for `dayKey`, else null (S3.2). */
export function openerForDay(thread: CoachThread, dayKey: string): CoachOpener | null {
  return thread.pendingOpener && thread.pendingOpener.dayKey === dayKey ? thread.pendingOpener : null;
}

export function setSpeakReplies(thread: CoachThread, on: boolean): CoachThread {
  return thread.speakReplies === on ? thread : { ...thread, speakReplies: on };
}

/**
 * Cloud merge for the thread (S1.5). Both inputs are sanitized first.
 *
 *   - inbound has no messages and no tombstone → keep local (a fresh device's
 *     defaults must never wipe a real thread; the same rule `inbox` follows).
 *   - inbound tombstone newer than local's newest message and local tombstone
 *     → the clear wins: empty thread, inbound tombstone.
 *   - local tombstone newer than inbound's newest message and inbound
 *     tombstone → local wins unchanged.
 *   - otherwise union messages by id (newest cap), prefer the newer pending
 *     plan (a plan already applying locally always wins), newer opener,
 *     max tombstone, local speakReplies (a device preference).
 */
export function mergeCoachThreads(localRaw: unknown, inboundRaw: unknown): CoachThread {
  const local = sanitizeCoachThread(localRaw);
  const inbound = sanitizeCoachThread(inboundRaw);

  const inboundHasContent = inbound.messages.length > 0 || inbound.pendingPlan !== null || inbound.pendingOpener !== null;
  if (!inboundHasContent && inbound.clearedAt === null) return local;

  // "Newest" counts every dated thing on a side: messages, the tombstone, the
  // plan, and the opener (an opener-only fresh device has real content too).
  const localNewest = Math.max(newestMessageAt(local), local.clearedAt ?? 0, local.pendingPlan?.createdAt ?? 0, local.pendingOpener?.at ?? 0);
  const inboundNewest = Math.max(newestMessageAt(inbound), inbound.clearedAt ?? 0, inbound.pendingPlan?.createdAt ?? 0, inbound.pendingOpener?.at ?? 0);

  if (inbound.clearedAt !== null && inbound.clearedAt >= localNewest) {
    return { ...emptyCoachThread(), clearedAt: inbound.clearedAt, speakReplies: local.speakReplies };
  }
  if (local.clearedAt !== null && local.clearedAt >= inboundNewest) {
    return local;
  }

  const clearedAt =
    local.clearedAt === null ? inbound.clearedAt : inbound.clearedAt === null ? local.clearedAt : Math.max(local.clearedAt, inbound.clearedAt);
  // Whatever the newest tombstone says was cleared stays cleared: a message,
  // plan or opener from before it must not ride back in on the union path
  // just because the other side also has newer content.
  const cutoff = clearedAt ?? 0;

  const byId = new Map<string, CoachMessage>();
  for (const m of [...inbound.messages, ...local.messages]) if (m.at > cutoff) byId.set(m.id, m);
  const messages = [...byId.values()].sort((a, b) => a.at - b.at).slice(-COACH_THREAD_CAP);

  const livePlan = (p: CoachPendingPlan | null) => (p && p.createdAt > cutoff ? p : null);
  const localPlan = livePlan(local.pendingPlan);
  const inboundPlan = livePlan(inbound.pendingPlan);
  let pendingPlan: CoachPendingPlan | null;
  if (localPlan && localPlan.applyingAt !== null) {
    pendingPlan = localPlan;
  } else if (localPlan && inboundPlan) {
    pendingPlan = inboundPlan.createdAt > localPlan.createdAt ? inboundPlan : localPlan;
  } else {
    pendingPlan = localPlan ?? inboundPlan;
  }

  // An opener stored before the tombstone is gone even on the same day, so a
  // cleared thread can write a fresh one (Greptile P1, #485 round 2).
  const liveOpener = (o: CoachOpener | null) => (o && (o.at ?? 0) > cutoff ? o : null);
  const localOpener = liveOpener(local.pendingOpener);
  const inboundOpener = liveOpener(inbound.pendingOpener);
  const pendingOpener =
    localOpener && inboundOpener
      ? (inboundOpener.dayKey > localOpener.dayKey ? inboundOpener : localOpener)
      : localOpener ?? inboundOpener;

  return { messages, pendingPlan, pendingOpener, clearedAt, speakReplies: local.speakReplies };
}



let idCounter = 0;
/** Unique enough for a per-user thread: time + a counter, no crypto needed. */
export function coachMessageId(at: number = Date.now()): string {
  idCounter = (idCounter + 1) % 100000;
  return `cm-${at.toString(36)}-${idCounter.toString(36)}`;
}
