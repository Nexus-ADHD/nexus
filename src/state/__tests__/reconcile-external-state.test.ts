import { describe, it, expect } from 'vitest';
import { reconcileInboxAgainstExternal } from '../reconcile-external-state';

// Local test fixture type. Declares `orphaned` so post-reconcile
// reads typecheck cleanly even when the input literal omits it.
type TestItem = {
  id: string;
  title: string;
  source: string;
  externalId?: string;
  completed: boolean;
  status: string;
  orphaned?: boolean;
};

// ───────────────────────────────────────────────────────────────────────
// Phase 3 reconcile reducer.
//
// The reducer is the only branch-heavy piece of the Reminders integration
// where unit tests are clearly worth more than they cost. Service-level
// EventKit calls and Zustand wiring are better verified on-device.
// ───────────────────────────────────────────────────────────────────────

const inc = (...ids: string[]) => new Set(ids);
const cmp = (...ids: string[]) => new Set(ids);

describe('reconcileInboxAgainstExternal', () => {
  it('leaves manual items alone regardless of bucket contents', () => {
    const inbox = [
      { id: 'a', title: 'Manual A', source: 'manual', completed: false, status: 'NEW' },
    ];
    const next = reconcileInboxAgainstExternal(inbox, {
      // Even if the manual item's id happens to collide with an external
      // id (it shouldn't, but defensively) reconcile must not touch it.
      incompleteIds: inc('a'),
      completedIds: cmp('a'),
    });
    expect(next[0]).toBe(inbox[0]); // identity preserved
  });

  it('apple-sourced item in incompleteIds is unchanged', () => {
    const inbox = [
      {
        id: 'i1',
        title: 'Yoga',
        source: 'apple_reminders',
        externalId: 'EXT-1',
        completed: false,
        status: 'NEW',
      },
    ];
    const next = reconcileInboxAgainstExternal(inbox, {
      incompleteIds: inc('EXT-1'),
      completedIds: cmp(),
    });
    expect(next[0]).toBe(inbox[0]); // identity preserved → no re-render
  });

  it('apple-sourced item in completedIds gets archived + completed, not orphaned', () => {
    const inbox: TestItem[] = [
      {
        id: 'i1',
        title: 'Yoga',
        source: 'apple_reminders',
        externalId: 'EXT-1',
        completed: false,
        status: 'NEW',
      },
    ];
    const next = reconcileInboxAgainstExternal(inbox, {
      incompleteIds: inc(),
      completedIds: cmp('EXT-1'),
    });
    expect(next[0].status).toBe('ARCHIVED');
    expect(next[0].completed).toBe(true);
    expect(next[0].orphaned).toBeUndefined(); // not orphaned, completed externally
  });

  it('apple-sourced item in neither bucket gets archived + orphaned', () => {
    const inbox: TestItem[] = [
      {
        id: 'i1',
        title: 'Mystery',
        source: 'apple_reminders',
        externalId: 'EXT-LOST',
        completed: false,
        status: 'NEW',
      },
    ];
    const next = reconcileInboxAgainstExternal(inbox, {
      incompleteIds: inc('EXT-other'),
      completedIds: cmp('EXT-something-else'),
    });
    expect(next[0].status).toBe('ARCHIVED');
    expect(next[0].orphaned).toBe(true);
    // completed flag should NOT be flipped — we don't know if the user
    // completed it or just deleted it; orphaned conveys the ambiguity.
    expect(next[0].completed).toBe(false);
  });

  it('already-archived items are never mutated regardless of bucket', () => {
    const inbox = [
      {
        id: 'i1',
        title: 'Old',
        source: 'apple_reminders',
        externalId: 'EXT-1',
        completed: true,
        status: 'ARCHIVED',
      },
    ];
    // Try every bucket combination — none should mutate.
    for (const bk of [
      { incompleteIds: inc('EXT-1'), completedIds: cmp() },
      { incompleteIds: inc(), completedIds: cmp('EXT-1') },
      { incompleteIds: inc(), completedIds: cmp() },
    ]) {
      const next = reconcileInboxAgainstExternal(inbox, bk);
      expect(next[0]).toBe(inbox[0]);
    }
  });

  it('apple-sourced item without externalId is left alone (defensive)', () => {
    const inbox = [
      {
        id: 'i1',
        title: 'Malformed',
        source: 'apple_reminders',
        // externalId intentionally missing
        completed: false,
        status: 'NEW',
      },
    ];
    const next = reconcileInboxAgainstExternal(inbox, {
      incompleteIds: inc(),
      completedIds: cmp(),
    });
    // Should NOT auto-orphan a malformed import — let the user delete
    // it manually rather than silently archiving on every sync.
    expect(next[0]).toBe(inbox[0]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// NEX-26 phase F.5 ext — completedAt stamping on Apple-sync flip.
// The activation tracker requires inbox items to carry a completedAt
// that reflects the day the user (or external sync) marked them done.
// Without this, all Apple-sync completions would be invisible to the
// tracker (skipped due to missing field).
// ───────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

type TimedItem = TestItem & { completedAt?: number };

describe('reconcileInboxAgainstExternal — completedAt stamping', () => {
  it('stamps completedAt when an Apple-sync item is confirmed externally complete', () => {
    const inbox: TimedItem[] = [
      { id: 'a', title: 'External', source: 'apple_reminders', externalId: 'ext-1', completed: false, status: 'NEW' },
    ];
    const next = reconcileInboxAgainstExternal(inbox, {
      incompleteIds: inc(),
      completedIds: cmp('ext-1'),
    }, NOW);
    expect(next[0].completed).toBe(true);
    expect(next[0].status).toBe('ARCHIVED');
    expect((next[0] as TimedItem).completedAt).toBe(NOW);
  });

  it('preserves an existing completedAt when external sync re-confirms', () => {
    // User cleared it in-app first (completedAt stamped by
    // applyToggleInbox), then Apple-sync surfaced the external
    // completion later. The first stamp must win.
    const FIRST_CLEAR = NOW - 86_400_000; // 1 day earlier
    const inbox: TimedItem[] = [
      {
        id: 'a',
        title: 'Cleared in-app',
        source: 'apple_reminders',
        externalId: 'ext-1',
        completed: false, // status field hasn't been archived yet
        status: 'NEW',
        completedAt: FIRST_CLEAR,
      },
    ];
    const next = reconcileInboxAgainstExternal(inbox, {
      incompleteIds: inc(),
      completedIds: cmp('ext-1'),
    }, NOW);
    expect(next[0].completed).toBe(true);
    expect(next[0].status).toBe('ARCHIVED');
    expect((next[0] as TimedItem).completedAt).toBe(FIRST_CLEAR);
  });

  it('does not stamp completedAt on rules 5 or 6 (incomplete / orphan)', () => {
    const inbox: TimedItem[] = [
      // rule 5: still incomplete externally
      { id: 'a', title: 'A', source: 'apple_reminders', externalId: 'ext-1', completed: false, status: 'NEW' },
      // rule 6: orphan (missing from both buckets)
      { id: 'b', title: 'B', source: 'apple_reminders', externalId: 'ext-2', completed: false, status: 'NEW' },
    ];
    const next = reconcileInboxAgainstExternal(inbox, {
      incompleteIds: inc('ext-1'),
      completedIds: cmp(),
    }, NOW);
    // rule 5 — unchanged, no completedAt added
    expect((next[0] as TimedItem).completedAt).toBeUndefined();
    expect(next[0].completed).toBe(false);
    // rule 6 — archived as orphan, no completedAt added
    expect((next[1] as TimedItem).completedAt).toBeUndefined();
    expect(next[1].completed).toBe(false);
    expect(next[1].status).toBe('ARCHIVED');
    expect(next[1].orphaned).toBe(true);
  });

  it('uses Date.now() default when no now argument is passed', () => {
    // Defensive: confirms the parameter default works for legacy
    // callers that haven't been updated. Tolerance check rather than
    // exact-match since Date.now() moves between lines.
    const before = Date.now();
    const inbox: TimedItem[] = [
      { id: 'a', title: 'External', source: 'apple_reminders', externalId: 'ext-1', completed: false, status: 'NEW' },
    ];
    const next = reconcileInboxAgainstExternal(inbox, {
      incompleteIds: inc(),
      completedIds: cmp('ext-1'),
    });
    const after = Date.now();
    const ts = (next[0] as TimedItem).completedAt!;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
