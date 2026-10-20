// NEX-285 — Inbox breakdown-stack grouping (pure, RN-free so vitest can cover it).
//
// When the Eye breaks a capture into steps, every step is a plain InboxTask sharing
// one `breakdownGroupId` + the original `goalTitle` + a 0-based `stepIndex`. The
// Inbox renders such a group as a single stacked card instead of N flat rows.
//
// `groupInboxRows` turns the FULL inbox into display rows for one filter tab.
// `flattenRowsToInbox` rebuilds a flat inbox from a drag-reordered row list.
//
// Both are pure. `groupInboxRows` derives from the full inbox (not the pre-filtered
// list) because a group's done/total counts need archived members too. Grouping is
// a NEW-tab affordance only; the ARCHIVED tab shows every item as a plain single.

import type { InboxTask } from '../../state/app-state';

export type InboxRow =
  | { key: string; kind: 'single'; task: InboxTask }
  | {
      key: string;
      kind: 'group';
      groupId: string;
      goalTitle?: string;
      /** Incomplete steps still to do, sorted by stepIndex. steps[0] is "on top". */
      steps: InboxTask[];
      doneCount: number;
      totalCount: number;
    };

/** The NEW tab excludes archived + triaged-skip; ARCHIVED shows only archived. */
function isVisible(t: InboxTask, isNew: boolean): boolean {
  return isNew
    ? t.status !== 'ARCHIVED' && !t.triagedSkip
    : t.status === 'ARCHIVED' && !t.triagedSkip;
}

/** Stable order within a group; missing indexes sort to the end (Array.sort is stable). */
function byStepIndex(a: InboxTask, b: InboxTask): number {
  const ai = typeof a.stepIndex === 'number' ? a.stepIndex : Number.MAX_SAFE_INTEGER;
  const bi = typeof b.stepIndex === 'number' ? b.stepIndex : Number.MAX_SAFE_INTEGER;
  return ai - bi;
}

/**
 * Build display rows for a filter tab from the FULL inbox.
 * - `filter === 'NEW'`: breakdown groups with >= 2 total members and >= 1 remaining
 *   incomplete step collapse into one `group` row (positioned at their earliest
 *   member). Degenerate groups (1 total, or all-done) and every non-breakdown item
 *   render as `single` rows. All singles obey the exact NEW predicate.
 * - `filter === 'ARCHIVED'`: no grouping; every archived item is a `single`.
 */
export function groupInboxRows(fullInbox: InboxTask[], filter: string): InboxRow[] {
  const inbox = Array.isArray(fullInbox) ? fullInbox : [];
  const isNew = filter === 'NEW';

  // Collect breakdown-group membership (NEW tab only). triagedSkip members are
  // excluded up front: they're neither a step nor "done", so they must not
  // inflate totalCount/doneCount. A "group" needs >= 2 members to earn stack
  // chrome. (In practice breakdown steps are never triagedSkip, but this keeps
  // the counts airtight regardless.)
  const members = new Map<string, InboxTask[]>();
  if (isNew) {
    for (const t of inbox) {
      const gid = t.breakdownGroupId;
      if (!gid || t.triagedSkip) continue;
      const list = members.get(gid);
      if (list) list.push(t);
      else members.set(gid, [t]);
    }
  }

  // Precompute qualifying groups once (>= 2 members AND >= 1 remaining incomplete
  // step) so the per-item loop below is O(1) per item, not O(members).
  const qualifying = new Set<string>();
  for (const [gid, list] of members) {
    if (list.length >= 2 && list.some((m) => m.status !== 'ARCHIVED')) qualifying.add(gid);
  }

  const rows: InboxRow[] = [];
  const emittedGroups = new Set<string>();

  for (const t of inbox) {
    const gid = isNew ? t.breakdownGroupId : undefined;
    if (gid && qualifying.has(gid)) {
      if (emittedGroups.has(gid)) continue; // group already placed at an earlier member
      emittedGroups.add(gid);
      const list = members.get(gid)!;
      const steps = list.filter((m) => m.status !== 'ARCHIVED').sort(byStepIndex);
      const doneCount = list.filter((m) => m.status === 'ARCHIVED').length;
      rows.push({
        key: `group:${gid}`,
        kind: 'group',
        groupId: gid,
        goalTitle: list.find((m) => m.goalTitle)?.goalTitle,
        steps,
        doneCount,
        totalCount: list.length,
      });
      continue;
    }
    // Non-grouped (or degenerate-group) item: render as a single if it's visible
    // in this tab. This reproduces the exact filter predicate so triaged-skip /
    // archived items never leak into the NEW list.
    if (isVisible(t, isNew)) {
      rows.push({ key: `task:${t.id}`, kind: 'single', task: t });
    }
  }

  return rows;
}

/**
 * Rebuild a flat inbox from a drag-reordered row list, honoring the new order while
 * preserving every item exactly once. Mirrors the existing handleDragEnd shape:
 * emit the ids the rows represent (in row order), then append every remaining live
 * item. Resolves each id against `liveInbox` so a concurrent store update mid-drag
 * is preserved and an item deleted mid-drag is dropped safely.
 *
 * Invariant: output ids === liveInbox ids, each exactly once.
 */
export function flattenRowsToInbox(rows: InboxRow[], liveInbox: InboxTask[]): InboxTask[] {
  const live = Array.isArray(liveInbox) ? liveInbox : [];
  const liveById = new Map(live.map((t) => [t.id, t] as const));
  const emitted = new Set<string>();
  const out: InboxTask[] = [];

  const push = (id: string) => {
    if (emitted.has(id)) return;
    const item = liveById.get(id);
    if (!item) return; // no longer in the inbox (deleted mid-drag) → drop
    emitted.add(id);
    out.push(item);
  };

  for (const row of rows ?? []) {
    if (row.kind === 'single') push(row.task.id);
    else for (const step of row.steps) push(step.id);
  }
  // Tail: every live item not represented in `rows` — carries each group's already-
  // archived members, the whole ARCHIVED set, triaged-skip, and any concurrent adds.
  for (const t of live) push(t.id);

  return out;
}
