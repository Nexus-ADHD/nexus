import { describe, expect, it } from 'vitest';
import type { InboxTask } from '../../../state/app-state';
import { flattenRowsToInbox, groupInboxRows, type InboxRow } from '../group-inbox-rows';

// Minimal InboxTask factory. `import type` above is erased at build, so this test
// never pulls the RN bundle (per vitest.config note).
function task(id: string, over: Partial<InboxTask> = {}): InboxTask {
  return { id, title: id, completed: false, status: 'NEW', source: 'manual', ...over };
}

// A breakdown group: N steps sharing one groupId + goalTitle, indexed 0..N-1.
function group(gid: string, goal: string, titles: string[], over: (i: number) => Partial<InboxTask> = () => ({})): InboxTask[] {
  return titles.map((t, i) =>
    task(`${gid}-${i}`, { title: t, breakdownGroupId: gid, goalTitle: goal, stepIndex: i, ...over(i) }),
  );
}

const ids = (arr: { id: string }[]) => arr.map((t) => t.id);

describe('groupInboxRows — NEW tab', () => {
  it('renders ungrouped items as singles, in order', () => {
    const inbox = [task('a'), task('b'), task('c')];
    const rows = groupInboxRows(inbox, 'NEW');
    expect(rows.map((r) => r.kind)).toEqual(['single', 'single', 'single']);
    expect(rows.map((r) => (r.kind === 'single' ? r.task.id : ''))).toEqual(['a', 'b', 'c']);
  });

  it('collapses a 6-step breakdown into one group row with sorted steps', () => {
    const inbox = group('g1', 'Go to the store', ['shoes', 'keys', 'lock', 'car', 'drive', 'buy']);
    const rows = groupInboxRows(inbox, 'NEW');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe('group');
    if (row.kind !== 'group') return;
    expect(row.groupId).toBe('g1');
    expect(row.goalTitle).toBe('Go to the store');
    expect(row.totalCount).toBe(6);
    expect(row.doneCount).toBe(0);
    expect(row.steps.map((s) => s.title)).toEqual(['shoes', 'keys', 'lock', 'car', 'drive', 'buy']);
  });

  it('advances: doneCount rises and steps[0] becomes the next incomplete step', () => {
    const inbox = group('g1', 'Go to the store', ['shoes', 'keys', 'lock'], (i) =>
      i === 0 ? { status: 'ARCHIVED' } : {},
    );
    const rows = groupInboxRows(inbox, 'NEW');
    const row = rows[0];
    expect(row.kind).toBe('group');
    if (row.kind !== 'group') return;
    expect(row.totalCount).toBe(3);
    expect(row.doneCount).toBe(1);
    expect(row.steps.map((s) => s.title)).toEqual(['keys', 'lock']);
    expect(row.steps[0].title).toBe('keys'); // next step on top
  });

  it('clears the stack from NEW when every step is archived', () => {
    const inbox = group('g1', 'g', ['a', 'b'], () => ({ status: 'ARCHIVED' }));
    expect(groupInboxRows(inbox, 'NEW')).toHaveLength(0);
  });

  it('a single-member group renders as a single, not a 1-item stack', () => {
    const inbox = group('g1', 'g', ['only']); // totalCount 1
    const rows = groupInboxRows(inbox, 'NEW');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('single');
  });

  it('a 2-member group with one archived still stacks (total 2, done 1)', () => {
    const inbox = group('g1', 'g', ['a', 'b'], (i) => (i === 0 ? { status: 'ARCHIVED' } : {}));
    const row = groupInboxRows(inbox, 'NEW')[0];
    expect(row.kind).toBe('group');
    if (row.kind !== 'group') return;
    expect(row.totalCount).toBe(2);
    expect(row.doneCount).toBe(1);
    expect(row.steps.map((s) => s.title)).toEqual(['b']);
  });

  it('positions the group at its earliest member and keeps other items as singles', () => {
    const g = group('g1', 'goal', ['s0', 's1']);
    // interleave: single, step0, single, step1, single
    const inbox = [task('x'), g[0], task('y'), g[1], task('z')];
    const rows = groupInboxRows(inbox, 'NEW');
    expect(rows.map((r) => r.key)).toEqual(['task:x', 'group:g1', 'task:y', 'task:z']);
  });

  it('keeps two distinct breakdowns as two separate stacks', () => {
    const a = group('gA', 'A', ['a0', 'a1']);
    const b = group('gB', 'B', ['b0', 'b1']);
    const rows = groupInboxRows([...a, ...b], 'NEW');
    expect(rows.map((r) => r.kind)).toEqual(['group', 'group']);
    expect(rows.map((r) => (r.kind === 'group' ? r.groupId : ''))).toEqual(['gA', 'gB']);
  });

  it('excludes archived and triaged-skip singles from NEW', () => {
    const inbox = [task('a'), task('b', { status: 'ARCHIVED' }), task('c', { triagedSkip: true })];
    const rows = groupInboxRows(inbox, 'NEW');
    expect(rows.map((r) => (r.kind === 'single' ? r.task.id : ''))).toEqual(['a']);
  });

  it('does not count a triaged-skip member in totalCount/doneCount', () => {
    // Unreachable in practice (steps are never triaged), but the counts stay honest.
    const inbox = group('g1', 'g', ['a', 'b', 'c'], (i) => (i === 2 ? { triagedSkip: true } : {}));
    const row = groupInboxRows(inbox, 'NEW')[0];
    if (row.kind !== 'group') throw new Error('expected group');
    expect(row.totalCount).toBe(2); // triaged member excluded
    expect(row.steps.map((s) => s.title)).toEqual(['a', 'b']);
  });

  it('missing stepIndex sorts to the end but stays stable', () => {
    const inbox = [
      task('g-2', { breakdownGroupId: 'g', goalTitle: 'g', title: 'no-index' }),
      task('g-0', { breakdownGroupId: 'g', goalTitle: 'g', stepIndex: 0, title: 'first' }),
      task('g-1', { breakdownGroupId: 'g', goalTitle: 'g', stepIndex: 1, title: 'second' }),
    ];
    const row = groupInboxRows(inbox, 'NEW')[0];
    if (row.kind !== 'group') throw new Error('expected group');
    expect(row.steps.map((s) => s.title)).toEqual(['first', 'second', 'no-index']);
  });
});

describe('groupInboxRows — ARCHIVED tab', () => {
  it('shows archived breakdown steps individually, never as a stack', () => {
    const inbox = group('g1', 'g', ['a', 'b', 'c'], () => ({ status: 'ARCHIVED' }));
    const rows = groupInboxRows(inbox, 'ARCHIVED');
    expect(rows.map((r) => r.kind)).toEqual(['single', 'single', 'single']);
  });

  it('excludes non-archived and triaged-skip from ARCHIVED', () => {
    const inbox = [
      task('a', { status: 'ARCHIVED' }),
      task('b'), // NEW
      task('c', { status: 'ARCHIVED', triagedSkip: true }),
    ];
    const rows = groupInboxRows(inbox, 'ARCHIVED');
    expect(rows.map((r) => (r.kind === 'single' ? r.task.id : ''))).toEqual(['a']);
  });
});

describe('flattenRowsToInbox — invariant: output ids === input ids, each once', () => {
  function assertSameIds(out: InboxTask[], live: InboxTask[]) {
    expect(new Set(ids(out))).toEqual(new Set(ids(live)));
    expect(out.length).toBe(live.length); // no dupes, no drops
  }

  it('round-trips a mixed inbox (group + archived members + singles + triaged + apple) losslessly', () => {
    const g = group('g1', 'goal', ['s0', 's1', 's2'], (i) => (i === 0 ? { status: 'ARCHIVED' } : {}));
    const live = [
      task('x'),
      ...g, // s0 archived (done), s1/s2 incomplete
      task('y', { triagedSkip: true }),
      task('z', { source: 'apple_reminders', externalId: 'r1' }),
      task('w', { status: 'ARCHIVED' }),
    ];
    const rows = groupInboxRows(live, 'NEW');
    const out = flattenRowsToInbox(rows, live);
    assertSameIds(out, live);
  });

  it('a drag reorder that moves the group to the front keeps members contiguous + preserves the tail', () => {
    const g = group('g1', 'goal', ['s0', 's1'], (i) => (i === 0 ? { status: 'ARCHIVED' } : {}));
    const live = [task('x'), ...g, task('y')];
    const rows = groupInboxRows(live, 'NEW'); // [single x, group g1, single y]
    const reordered: InboxRow[] = [rows[1], rows[0], rows[2]]; // group first now
    const out = flattenRowsToInbox(reordered, live);
    // Incomplete step s1 leads (only remaining), then x, then y; archived s0 in tail.
    expect(ids(out).slice(0, 3)).toEqual(['g1-1', 'x', 'y']);
    expect(ids(out)).toContain('g1-0'); // archived member preserved
    expect(out.length).toBe(live.length);
  });

  it('drops an id deleted mid-drag (row references a task no longer in the live inbox)', () => {
    const live = [task('a'), task('b')];
    const staleRows: InboxRow[] = [
      { key: 'task:a', kind: 'single', task: task('a') },
      { key: 'task:ghost', kind: 'single', task: task('ghost') }, // not in live
      { key: 'task:b', kind: 'single', task: task('b') },
    ];
    const out = flattenRowsToInbox(staleRows, live);
    expect(ids(out)).toEqual(['a', 'b']);
  });

  it('uses the live reference, preserving a concurrent update that happened mid-drag', () => {
    const staleA = task('a', { title: 'old' });
    const liveA = task('a', { title: 'new' }); // store changed during the drag
    const live = [liveA, task('b')];
    const rows: InboxRow[] = [
      { key: 'task:a', kind: 'single', task: staleA },
      { key: 'task:b', kind: 'single', task: task('b') },
    ];
    const out = flattenRowsToInbox(rows, live);
    expect(out[0]).toBe(liveA); // identity: the live object, not the stale row copy
    expect(out[0].title).toBe('new');
  });

  it('never duplicates when a group row and the tail both reach the same ids', () => {
    const g = group('g1', 'goal', ['s0', 's1']);
    const live = [...g];
    const rows = groupInboxRows(live, 'NEW');
    const out = flattenRowsToInbox(rows, live);
    expect(ids(out).sort()).toEqual(['g1-0', 'g1-1']);
    expect(out.length).toBe(2);
  });
});
