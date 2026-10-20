/**
 * NEX-313 — reconciling Home-Screen habit completions back into the app.
 *
 * The widget button is COMPLETE, not toggle, so the whole point of these tests
 * is that the dangerous cases — a queue read twice, the same habit tapped
 * twice, a habit already done — are no-ops rather than double-applies. The one
 * case that must NOT be silent is a completion getting lost, so the applied set
 * is pinned exactly.
 */
import { describe, expect, it } from 'vitest';
import {
  planWidgetCompletions,
  type WidgetCompletionAction,
} from '../widget-completion-reconciler';
import { normalize } from '../../utils/text';

const TODAY = '2026-07-23';

const action = (over: Partial<WidgetCompletionAction> = {}): WidgetCompletionAction => ({
  id: 'a1',
  habitTitle: 'Meditation',
  dayKey: TODAY,
  at: 1_800_000_000_000,
  ...over,
});

const log = (habitTitle: string, dateKey: string) => ({
  id: `l-${habitTitle}-${dateKey}`,
  habitTitle,
  goalIds: [],
  dateKey,
  timestamp: 1,
});

const known = (...titles: string[]) => new Set(titles.map((t) => normalize(t)));

describe('planWidgetCompletions — never throws, always clears', () => {
  it('tolerates a garbage queue', () => {
    for (const bad of [undefined, null, 'nope', {}, [null, 42, 'x']]) {
      const plan = planWidgetCompletions(bad as any, [], known('Meditation'));
      expect(plan.toApply).toEqual([]);
      expect(plan.clearQueue).toBe(true);
    }
  });

  it('clears the queue even when every action was skipped', () => {
    // A queue read but not cleared replays its stale actions every foreground.
    const plan = planWidgetCompletions([action({ habitTitle: 'Ghost' })], [], known('Meditation'));
    expect(plan.toApply).toEqual([]);
    expect(plan.clearQueue).toBe(true);
  });

  it('drops malformed entries without dropping the good ones', () => {
    const plan = planWidgetCompletions(
      [action(), null, { habitTitle: 'Read' }, { dayKey: TODAY }, action({ habitTitle: '   ' })],
      [],
      known('Meditation', 'Read'),
    );
    expect(plan.toApply.map((c) => c.habitTitle)).toEqual(['Meditation']);
  });
});

describe('planWidgetCompletions — idempotent by construction (the whole safety story)', () => {
  it('skips a habit already logged for that day', () => {
    const plan = planWidgetCompletions([action()], [log(normalize('Meditation'), TODAY)], known('Meditation'));
    expect(plan.toApply).toEqual([]);
  });

  it('applies the same action id read twice exactly once', () => {
    const dup = action({ id: 'same' });
    const plan = planWidgetCompletions([dup, dup], [], known('Meditation'));
    expect(plan.toApply).toHaveLength(1);
  });

  it('applies two DIFFERENT taps of the same habit/day exactly once', () => {
    const plan = planWidgetCompletions(
      [action({ id: 'x' }), action({ id: 'y' })],
      [],
      known('Meditation'),
    );
    expect(plan.toApply).toHaveLength(1);
  });

  it('matches the canonical completion key: emoji-sensitive, matching logHabit', () => {
    // The log stores normalize(title). A widget tap carries the raw title; it is
    // applied only if not already logged under the same normalized key.
    const plan = planWidgetCompletions(
      [action({ habitTitle: '  Meditation  ' })],
      [log(normalize('meditation'), TODAY)],
      known('Meditation'),
    );
    expect(plan.toApply).toEqual([]); // whitespace/case fold to the same key
  });
});

describe('planWidgetCompletions — a stale widget must not resurrect a deleted habit', () => {
  it('skips an action whose habit no longer exists', () => {
    const plan = planWidgetCompletions([action({ habitTitle: 'Deleted habit' })], [], known('Meditation'));
    expect(plan.toApply).toEqual([]);
  });

  it('applies the known habits and skips the unknown ones in one queue', () => {
    const plan = planWidgetCompletions(
      [action({ habitTitle: 'Meditation' }), action({ id: 'b', habitTitle: 'Deleted' })],
      [],
      known('Meditation'),
    );
    expect(plan.toApply.map((c) => c.habitTitle)).toEqual(['Meditation']);
  });
});

describe('planWidgetCompletions — applies to the day it was tapped, not "today"', () => {
  it('completes yesterday if that is when the tap happened', () => {
    const yesterday = '2026-07-22';
    const plan = planWidgetCompletions(
      [action({ dayKey: yesterday })],
      [],
      known('Meditation'),
      TODAY, // "today" is passed but must not override the action's own day
    );
    expect(plan.toApply).toEqual([{ habitTitle: 'Meditation', dayKey: yesterday }]);
  });

  it('treats the same habit on two different days as two completions', () => {
    const plan = planWidgetCompletions(
      [action({ id: 'x', dayKey: '2026-07-22' }), action({ id: 'y', dayKey: TODAY })],
      [],
      known('Meditation'),
    );
    expect(plan.toApply).toHaveLength(2);
    expect(plan.toApply.map((c) => c.dayKey).sort()).toEqual(['2026-07-22', TODAY]);
  });

  it('carries the RAW title through so logHabit can store its canonical key', () => {
    const plan = planWidgetCompletions([action({ habitTitle: 'Read 20 min' })], [], known('Read 20 min'));
    expect(plan.toApply[0].habitTitle).toBe('Read 20 min');
  });
});

describe('planWidgetCompletions — multi-rep habits (timesPerDay > 1)', () => {
  // Map form: normalize(title) -> daily target. A 2x/day habit (Read Mantra,
  // Meditation) must accept one tap PER REP — the boolean once-a-day collapse
  // applies only past the target.
  const knownWithTargets = (...entries: [string, number][]) =>
    new Map(entries.map(([t, n]) => [normalize(t), n] as const));

  it('applies each tap of a twice-daily habit up to its target', () => {
    const plan = planWidgetCompletions(
      [action({ id: 'x' }), action({ id: 'y' })],
      [],
      knownWithTargets(['Meditation', 2]),
    );
    expect(plan.toApply).toHaveLength(2);
  });

  it('caps taps past the daily target — the idempotency story, count edition', () => {
    const plan = planWidgetCompletions(
      [action({ id: 'x' }), action({ id: 'y' }), action({ id: 'z' })],
      [],
      knownWithTargets(['Meditation', 2]),
    );
    expect(plan.toApply).toHaveLength(2);
  });

  it('counts persisted reps toward the target: 1 logged + 2 queued → 1 more', () => {
    const plan = planWidgetCompletions(
      [action({ id: 'x' }), action({ id: 'y' })],
      [log(normalize('Meditation'), TODAY)],
      knownWithTargets(['Meditation', 2]),
    );
    expect(plan.toApply).toHaveLength(1);
  });

  it('a twice-daily habit already at target applies nothing', () => {
    const plan = planWidgetCompletions(
      [action()],
      [log(normalize('Meditation'), TODAY), log(normalize('Meditation'), TODAY)],
      knownWithTargets(['Meditation', 2]),
    );
    expect(plan.toApply).toEqual([]);
  });

  it('Set callers keep the original once-per-day behavior', () => {
    const plan = planWidgetCompletions(
      [action({ id: 'x' }), action({ id: 'y' })],
      [],
      known('Meditation'),
    );
    expect(plan.toApply).toHaveLength(1);
  });
});
