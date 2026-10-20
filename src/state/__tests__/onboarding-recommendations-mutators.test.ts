import { describe, expect, it } from 'vitest';
import {
  applyMandateTitle,
  applyMandateRefresh,
  applyHabitRefresh,
  applyTodoRefresh,
  applyMandateDownstream,
  REFRESH_CAP,
} from '../onboarding-recommendations-reducers';

// Inline test types match the shape declared in app-state.ts. Keeping
// them local avoids pulling app-state's runtime import chain (which
// drags AsyncStorage in) into the pure-Node vitest runner.
type Mandate = {
  id: string;
  slotId: string;
  title: string;
  category: string;
  rationaleSource: 'bestVersion' | 'stop' | 'continue' | 'focus';
  rationale: string;
  refreshCount: number;
};
type Habit = {
  slotId: string;
  title: string;
  daysOfWeek: number[];
  mandateId: string;
  rationale: string;
  added: boolean;
  refreshCount: number;
};
type Todo = {
  slotId: string;
  title: string;
  mandateId: string;
  rationale: string;
  added: boolean;
  refreshCount: number;
};
type RecurringTodo = {
  slotId: string;
  title: string;
  daysOfWeek: number[];
  mandateId: string;
  rationale: string;
  added: boolean;
  refreshCount: number;
};
type Recs = {
  generatedAt: number;
  mandates: Mandate[];
  habits: Habit[];
  recurringTodos: RecurringTodo[];
  todos: Todo[];
  disambiguation: null;
};

function fixture(): Recs {
  return {
    generatedAt: 0,
    mandates: [
      { id: 'm-1', slotId: 'm-1', title: 'Be present with family', category: 'PERSONAL', rationaleSource: 'bestVersion', rationale: 'Names the family thread in the reflection.', refreshCount: 0 },
      { id: 'm-2', slotId: 'm-2', title: 'Master the writing craft', category: 'BUSINESS', rationaleSource: 'continue', rationale: 'Names the writing thread the user wanted to continue.', refreshCount: 0 },
    ],
    habits: [
      { slotId: 'h-1', title: 'Phone-free dinners', daysOfWeek: [0,1,2,3,4,5,6], mandateId: 'm-1', rationale: 'r1', added: false, refreshCount: 0 },
      { slotId: 'h-2', title: 'Daily writing', daysOfWeek: [1,2,3,4,5], mandateId: 'm-2', rationale: 'r2', added: false, refreshCount: 0 },
    ],
    recurringTodos: [],
    todos: [
      { slotId: 't-1', title: 'Plan one weekend activity with the kids', mandateId: 'm-1', rationale: 'r1', added: false, refreshCount: 0 },
      { slotId: 't-2', title: 'Outline the next chapter of your novel', mandateId: 'm-2', rationale: 'r2', added: false, refreshCount: 0 },
    ],
    disambiguation: null,
  };
}

// ─── applyMandateTitle ───────────────────────────────────────────────────────

describe('applyMandateTitle', () => {
  it('updates the title and does NOT tick refreshCount', () => {
    const next = applyMandateTitle(fixture() as any, 'm-1', 'Show up for my family');
    expect(next!.mandates[0].title).toBe('Show up for my family');
    expect(next!.mandates[0].refreshCount).toBe(0);
  });

  it('trims the new title', () => {
    const next = applyMandateTitle(fixture() as any, 'm-1', '  Show up  ');
    expect(next!.mandates[0].title).toBe('Show up');
  });

  it('no-ops on empty/whitespace title', () => {
    const f = fixture();
    expect(applyMandateTitle(f as any, 'm-1', '   ')).toBe(f);
  });

  it('no-ops when title is identical to the current value', () => {
    const f = fixture();
    expect(applyMandateTitle(f as any, 'm-1', 'Be present with family')).toBe(f);
  });

  it('no-ops on unknown mandateId', () => {
    const f = fixture();
    expect(applyMandateTitle(f as any, 'm-nope', 'whatever')).toBe(f);
  });

  it('returns null when recs is null', () => {
    expect(applyMandateTitle(null, 'm-1', 'x')).toBeNull();
  });

  it('does not mutate the input slice', () => {
    const f = fixture();
    const original = f.mandates[0].title;
    applyMandateTitle(f as any, 'm-1', 'New title');
    expect(f.mandates[0].title).toBe(original);
  });
});

// ─── applyMandateRefresh ─────────────────────────────────────────────────────

describe('applyMandateRefresh', () => {
  const fields = {
    title: 'Show up for my family',
    category: 'PERSONAL',
    rationaleSource: 'bestVersion' as const,
    rationale: 'Names the family thread reframed after a refresh.',
  };

  it('replaces fields and ticks refreshCount', () => {
    const next = applyMandateRefresh(fixture() as any, 'm-1', fields);
    expect(next!.mandates[0].title).toBe('Show up for my family');
    expect(next!.mandates[0].refreshCount).toBe(1);
  });

  it('preserves id and slotId across refresh', () => {
    const next = applyMandateRefresh(fixture() as any, 'm-1', fields);
    expect(next!.mandates[0].id).toBe('m-1');
    expect(next!.mandates[0].slotId).toBe('m-1');
  });

  it('no-ops at REFRESH_CAP', () => {
    const f = fixture();
    f.mandates[0].refreshCount = REFRESH_CAP;
    const next = applyMandateRefresh(f as any, 'm-1', fields);
    // Returns the input slice unchanged.
    expect(next).toBe(f);
    expect(next!.mandates[0].title).toBe('Be present with family');
    expect(next!.mandates[0].refreshCount).toBe(REFRESH_CAP);
  });

  it('eight successive calls bring counter to cap', () => {
    let recs: any = fixture();
    for (let i = 0; i < REFRESH_CAP; i++) {
      recs = applyMandateRefresh(recs, 'm-1', { ...fields, title: `v${i + 1}` });
    }
    expect(recs.mandates[0].refreshCount).toBe(REFRESH_CAP);
    // Ninth call is a no-op.
    const after = applyMandateRefresh(recs, 'm-1', { ...fields, title: 'v9' });
    expect(after).toBe(recs);
  });

  it('no-ops on unknown mandateId', () => {
    const f = fixture();
    expect(applyMandateRefresh(f as any, 'm-nope', fields)).toBe(f);
  });
});

// ─── applyHabitRefresh ───────────────────────────────────────────────────────

describe('applyHabitRefresh', () => {
  const fields = {
    title: 'Evening reflection',
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    rationale: 'A short evening close.',
  };

  it('replaces fields and ticks refreshCount', () => {
    const next = applyHabitRefresh(fixture() as any, 'h-1', fields);
    expect(next!.habits[0].title).toBe('Evening reflection');
    expect(next!.habits[0].refreshCount).toBe(1);
  });

  it('preserves slotId and mandateId across refresh', () => {
    const next = applyHabitRefresh(fixture() as any, 'h-1', fields);
    expect(next!.habits[0].slotId).toBe('h-1');
    expect(next!.habits[0].mandateId).toBe('m-1');
  });

  it('clones daysOfWeek so caller mutation does not leak', () => {
    const days = [1, 3, 5];
    const next = applyHabitRefresh(fixture() as any, 'h-1', { ...fields, daysOfWeek: days });
    days.push(6);
    expect(next!.habits[0].daysOfWeek).toEqual([1, 3, 5]);
  });

  it('no-ops at REFRESH_CAP', () => {
    const f = fixture();
    f.habits[0].refreshCount = REFRESH_CAP;
    const next = applyHabitRefresh(f as any, 'h-1', fields);
    expect(next).toBe(f);
  });

  it('no-ops on unknown slotId', () => {
    const f = fixture();
    expect(applyHabitRefresh(f as any, 'h-nope', fields)).toBe(f);
  });
});

// ─── applyTodoRefresh ────────────────────────────────────────────────────────

describe('applyTodoRefresh', () => {
  const fields = {
    title: 'Schedule weekly review for Sunday',
    rationale: 'Keeps mandates load-bearing.',
  };

  it('replaces fields and ticks refreshCount', () => {
    const next = applyTodoRefresh(fixture() as any, 't-1', fields);
    expect(next!.todos[0].title).toBe('Schedule weekly review for Sunday');
    expect(next!.todos[0].refreshCount).toBe(1);
  });

  it('preserves slotId and mandateId across refresh', () => {
    const next = applyTodoRefresh(fixture() as any, 't-1', fields);
    expect(next!.todos[0].slotId).toBe('t-1');
    expect(next!.todos[0].mandateId).toBe('m-1');
  });

  it('no-ops at REFRESH_CAP', () => {
    const f = fixture();
    f.todos[0].refreshCount = REFRESH_CAP;
    expect(applyTodoRefresh(f as any, 't-1', fields)).toBe(f);
  });

  it('no-ops on unknown slotId', () => {
    const f = fixture();
    expect(applyTodoRefresh(f as any, 't-nope', fields)).toBe(f);
  });
});

// ─── applyMandateDownstream ──────────────────────────────────────────────────

// ─── applyMandateDownstream ──────────────────────────────────────────────
//
// NEX-57: signature is (recs, mandateId, newHabits[], newRecurringTodos[],
// newTodos[]). The reducer preserves ADDed items for the mandate and
// drops un-ADDed ones, then appends the fresh pool from the caller.

describe('applyMandateDownstream', () => {
  const newHabits: Habit[] = [
    {
      slotId: 'h-cascade-1',
      title: 'Phone-free dinners',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      mandateId: 'IGNORED-will-be-overwritten',
      rationale: 'Cascade habit one.',
      added: true, // should be reset to false by the reducer
      refreshCount: 5, // should reset to 0 in the reducer
    },
    {
      slotId: 'h-cascade-2',
      title: 'Saturday family ritual',
      daysOfWeek: [6],
      mandateId: 'IGNORED',
      rationale: 'Cascade habit two.',
      added: false,
      refreshCount: 5,
    },
  ];
  const newRecurringTodos: RecurringTodo[] = [];
  const newTodos: Todo[] = [
    {
      slotId: 't-cascade-1',
      title: 'Cascade todo one',
      mandateId: 'IGNORED',
      rationale: 'r',
      added: false,
      refreshCount: 3,
    },
    {
      slotId: 't-cascade-2',
      title: 'Cascade todo two',
      mandateId: 'IGNORED',
      rationale: 'r',
      added: false,
      refreshCount: 7,
    },
  ];

  it('replaces un-ADDed habits and todos under the mandate with the new pool', () => {
    const next = applyMandateDownstream(fixture() as any, 'm-1', newHabits, newRecurringTodos, newTodos);
    const habitsForM1 = next!.habits.filter((h) => h.mandateId === 'm-1');
    const todosForM1 = next!.todos.filter((t) => t.mandateId === 'm-1');
    expect(habitsForM1).toHaveLength(2);
    expect(habitsForM1.map((h) => h.slotId)).toEqual(
      expect.arrayContaining(['h-cascade-1', 'h-cascade-2']),
    );
    // Old h-1 (un-ADDed by default) was dropped.
    expect(habitsForM1.map((h) => h.slotId)).not.toContain('h-1');
    expect(todosForM1).toHaveLength(2);
    expect(todosForM1.map((t) => t.slotId)).toEqual(
      expect.arrayContaining(['t-cascade-1', 't-cascade-2']),
    );
    expect(todosForM1.map((t) => t.slotId)).not.toContain('t-1');
  });

  it('does NOT tick any refresh counters and forces added=false on new items', () => {
    const next = applyMandateDownstream(fixture() as any, 'm-1', newHabits, newRecurringTodos, newTodos);
    const habitsForM1 = next!.habits.filter((h) => h.mandateId === 'm-1');
    const todosForM1 = next!.todos.filter((t) => t.mandateId === 'm-1');
    expect(habitsForM1.every((h) => h.refreshCount === 0)).toBe(true);
    expect(habitsForM1.every((h) => h.added === false)).toBe(true);
    expect(todosForM1.every((t) => t.refreshCount === 0)).toBe(true);
    expect(todosForM1.every((t) => t.added === false)).toBe(true);
  });

  it('rewrites mandateId on new entries even if caller passed something else', () => {
    const next = applyMandateDownstream(fixture() as any, 'm-1', newHabits, newRecurringTodos, newTodos);
    const newHabitsInSlice = next!.habits.filter(
      (h) => h.slotId === 'h-cascade-1' || h.slotId === 'h-cascade-2',
    );
    expect(newHabitsInSlice.every((h) => h.mandateId === 'm-1')).toBe(true);
    const newTodosInSlice = next!.todos.filter(
      (t) => t.slotId === 't-cascade-1' || t.slotId === 't-cascade-2',
    );
    expect(newTodosInSlice.every((t) => t.mandateId === 'm-1')).toBe(true);
  });

  it('leaves other mandates untouched', () => {
    const next = applyMandateDownstream(fixture() as any, 'm-1', newHabits, newRecurringTodos, newTodos);
    const m2Habits = next!.habits.filter((h) => h.mandateId === 'm-2');
    const m2Todos = next!.todos.filter((t) => t.mandateId === 'm-2');
    expect(m2Habits.map((h) => h.title)).toEqual(['Daily writing']);
    expect(m2Todos.map((t) => t.title)).toEqual(['Outline the next chapter of your novel']);
  });

  it('bypasses the refresh cap (system-initiated, not user-requested)', () => {
    const f = fixture();
    f.habits[0].refreshCount = REFRESH_CAP;
    f.todos[0].refreshCount = REFRESH_CAP;
    const next = applyMandateDownstream(f as any, 'm-1', newHabits, newRecurringTodos, newTodos);
    // The old un-ADDed slots are gone; the new ones have refreshCount 0.
    const habitsForM1 = next!.habits.filter((h) => h.mandateId === 'm-1');
    expect(habitsForM1.map((h) => h.slotId)).not.toContain('h-1');
    expect(habitsForM1.every((h) => h.refreshCount === 0)).toBe(true);
  });

  it('no-ops on unknown mandateId', () => {
    const f = fixture();
    expect(applyMandateDownstream(f as any, 'm-nope', newHabits, newRecurringTodos, newTodos)).toBe(f);
  });

  // NEX-57: preservation tests.

  it('preserves ADDed habits for the mandate alongside the new pool', () => {
    const f = fixture();
    // Mark h-1 (M1's only habit in this fixture) as ADDed by the user.
    f.habits[0].added = true;
    const next = applyMandateDownstream(f as any, 'm-1', newHabits, newRecurringTodos, newTodos);
    const habitsForM1 = next!.habits.filter((h) => h.mandateId === 'm-1');
    // h-1 survives because it was ADDed; the 2 new habits are appended.
    expect(habitsForM1).toHaveLength(3);
    expect(habitsForM1.map((h) => h.slotId)).toEqual(
      expect.arrayContaining(['h-1', 'h-cascade-1', 'h-cascade-2']),
    );
    // The preserved habit keeps added=true; the new ones are added=false.
    const preserved = habitsForM1.find((h) => h.slotId === 'h-1')!;
    expect(preserved.added).toBe(true);
    const newOnes = habitsForM1.filter((h) => h.slotId !== 'h-1');
    expect(newOnes.every((h) => h.added === false)).toBe(true);
  });

  it('preserves ADDed items across all three buckets (habits, recurring, todos)', () => {
    const f = fixture();
    // Mark M1's existing habit and todo as ADDed, and add an ADDed
    // recurringTodo for M1 to exercise all three buckets.
    f.habits[0].added = true; // h-1 (m-1)
    f.todos[0].added = true; // t-1 (m-1)
    f.recurringTodos.push({
      slotId: 'rt-1',
      title: 'Walk together after dinner',
      daysOfWeek: [0, 2, 4, 6],
      mandateId: 'm-1',
      rationale: 'r',
      added: true,
      refreshCount: 0,
    });
    const cascadeRecurring: RecurringTodo[] = [
      {
        slotId: 'rt-cascade-1',
        title: 'Cascade recurring one',
        daysOfWeek: [1, 3, 5],
        mandateId: 'IGNORED',
        rationale: 'r',
        added: false,
        refreshCount: 0,
      },
    ];
    const next = applyMandateDownstream(f as any, 'm-1', newHabits, cascadeRecurring, newTodos);
    // Each bucket: the ADDed item survives, the new pool is appended.
    expect(next!.habits.filter((h) => h.mandateId === 'm-1').map((h) => h.slotId)).toEqual(
      expect.arrayContaining(['h-1', 'h-cascade-1', 'h-cascade-2']),
    );
    expect(next!.recurringTodos.filter((rt) => rt.mandateId === 'm-1').map((rt) => rt.slotId)).toEqual(
      expect.arrayContaining(['rt-1', 'rt-cascade-1']),
    );
    expect(next!.todos.filter((t) => t.mandateId === 'm-1').map((t) => t.slotId)).toEqual(
      expect.arrayContaining(['t-1', 't-cascade-1', 't-cascade-2']),
    );
  });
});
