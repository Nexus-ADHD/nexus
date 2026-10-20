/**
 * NEX-315 — the pure decision inside the foreground drain.
 *
 * The reconciler's idempotency is covered in widget-completion-reconciler.test.
 * This pins the drain's two added responsibilities: it only applies completions
 * logHabit can honor (today), and it derives the "known habit" set with the
 * SAME normalizer the reconciler and logHabit use, so a real habit is never
 * wrongly skipped.
 */
import { describe, expect, it } from 'vitest';
import { selectDrainCompletions } from '../widget-completion-drain';
import { normalize } from '../../utils/text';

const TODAY = '2026-07-23';
const rules = [{ title: 'Meditation' }, { title: 'Read 20 min' }, { title: 'Run 🏃' }];
const q = (over = {}) => ({ id: 'a1', habitTitle: 'Meditation', dayKey: TODAY, at: 1, ...over });
const logged = (title: string, dateKey: string) => ({ habitTitle: normalize(title), dateKey });

describe('selectDrainCompletions', () => {
  it('returns raw titles for today, for habits that exist and are not done', () => {
    expect(selectDrainCompletions([q()], [], rules, TODAY)).toEqual(['Meditation']);
  });

  it('drops a completion the widget stamped for a non-today day (logHabit is today-only)', () => {
    expect(selectDrainCompletions([q({ dayKey: '2026-07-22' })], [], rules, TODAY)).toEqual([]);
  });

  it('skips a habit already logged today', () => {
    expect(selectDrainCompletions([q()], [logged('Meditation', TODAY)], rules, TODAY)).toEqual([]);
  });

  it('skips a habit that no longer exists (stale widget must not resurrect it)', () => {
    expect(selectDrainCompletions([q({ habitTitle: 'Deleted' })], [], rules, TODAY)).toEqual([]);
  });

  it('matches known habits through the canonical normalizer, emoji and case included', () => {
    // "Run 🏃" is a real rule; a tap carrying it must be recognized as known.
    expect(selectDrainCompletions([q({ habitTitle: 'Run 🏃' })], [], rules, TODAY)).toEqual(['Run 🏃']);
    // A whitespace/case variant of a known title is still recognized (matched
    // via normalize) and the RAW title is carried through unchanged — logHabit
    // normalizes internally, so it stores under the same key either way.
    expect(selectDrainCompletions([q({ habitTitle: '  Meditation  ' })], [], rules, TODAY))
      .toEqual(['  Meditation  ']);
  });

  it('is idempotent across duplicate actions', () => {
    expect(selectDrainCompletions([q({ id: 'x' }), q({ id: 'y' })], [], rules, TODAY)).toEqual(['Meditation']);
  });

  it('never throws on garbage', () => {
    for (const bad of [null, undefined, 'nope', {}, [null, 42]]) {
      expect(() => selectDrainCompletions(bad, null, null, TODAY)).not.toThrow();
      expect(selectDrainCompletions(bad, null, null, TODAY)).toEqual([]);
    }
  });
});

describe('selectDrainCompletions — multi-rep habits (timesPerDay > 1)', () => {
  const multi = [{ title: 'Read Mantra', timesPerDay: 2 }];

  it('applies one tap PER REP for a twice-daily habit', () => {
    expect(
      selectDrainCompletions(
        [q({ habitTitle: 'Read Mantra' }), q({ id: 'b', habitTitle: 'Read Mantra' })],
        [],
        multi,
        TODAY,
      ),
    ).toEqual(['Read Mantra', 'Read Mantra']);
  });

  it('a habit with one rep already logged accepts only its remaining reps', () => {
    expect(
      selectDrainCompletions(
        [q({ habitTitle: 'Read Mantra' }), q({ id: 'b', habitTitle: 'Read Mantra' })],
        [logged('Read Mantra', TODAY)],
        multi,
        TODAY,
      ),
    ).toEqual(['Read Mantra']);
  });

  it('a habit at its daily target applies nothing further', () => {
    expect(
      selectDrainCompletions(
        [q({ habitTitle: 'Read Mantra' })],
        [logged('Read Mantra', TODAY), logged('Read Mantra', TODAY)],
        multi,
        TODAY,
      ),
    ).toEqual([]);
  });
});

describe('selectDrainCompletions — duplicate-titled rules', () => {
  it('resolves the daily target by FIRST matching rule, exactly like logHabit', () => {
    // Two rules normalize to the same title with different targets. logHabit
    // uses recurringRules.find — the FIRST match — so the drain must plan
    // against that same target or valid taps are dropped and cleared.
    const dup = [{ title: 'Meditation', timesPerDay: 2 }, { title: 'Meditation', timesPerDay: 1 }];
    expect(selectDrainCompletions([q(), q({ id: 'b' })], [], dup, TODAY))
      .toEqual(['Meditation', 'Meditation']);
  });
});
