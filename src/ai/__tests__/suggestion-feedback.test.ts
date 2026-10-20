/**
 * NEX-308 — the AI-suggestion outcome log.
 *
 * This rides a UI tap path (adding a habit, regenerating a set), so the two
 * properties that matter most are: it never throws on bad input, and it never
 * grows without bound.
 */
import { describe, expect, it } from 'vitest';
import {
  recordSuggestionOutcomes,
  MAX_FEEDBACK_ENTRIES,
  MAX_TITLE_CHARS,
  type SuggestionFeedbackEntry,
} from '../suggestion-feedback';

const NOW = 1_800_000_000_000;

const accepted = (title: string) =>
  ({ kind: 'habit' as const, outcome: 'accepted' as const, title, mandateId: 'm-1' });

describe('recordSuggestionOutcomes — appending', () => {
  it('appends newest-last and stamps `at` from the injected clock', () => {
    const out = recordSuggestionOutcomes([], [accepted('Lift 4x/week')], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: 'habit',
      outcome: 'accepted',
      title: 'Lift 4x/week',
      mandateId: 'm-1',
      at: NOW,
    });
  });

  it('preserves an explicit `at` when the caller supplies one', () => {
    const out = recordSuggestionOutcomes([], [{ ...accepted('A'), at: 123 }], NOW);
    expect(out[0].at).toBe(123);
  });

  it('folds a whole rejected set in one call (the regenerate path)', () => {
    const out = recordSuggestionOutcomes(
      [],
      [
        { kind: 'habit', outcome: 'regenerated', title: 'H1', mandateId: 'm-1' },
        { kind: 'habit', outcome: 'regenerated', title: 'H2', mandateId: 'm-1' },
        { kind: 'todo', outcome: 'regenerated', title: 'T1', mandateId: 'm-1' },
      ],
      NOW,
    );
    expect(out.map((e) => e.title)).toEqual(['H1', 'H2', 'T1']);
    expect(out.every((e) => e.outcome === 'regenerated')).toBe(true);
  });

  it('keeps existing entries and appends after them', () => {
    const first = recordSuggestionOutcomes([], [accepted('First')], NOW);
    const second = recordSuggestionOutcomes(first, [accepted('Second')], NOW);
    expect(second.map((e) => e.title)).toEqual(['First', 'Second']);
  });
});

describe('recordSuggestionOutcomes — bounded (the NEX-306 append-only lesson)', () => {
  it('caps at MAX_FEEDBACK_ENTRIES, dropping the OLDEST', () => {
    const many = Array.from({ length: MAX_FEEDBACK_ENTRIES + 40 }, (_, n) => accepted(`item ${n}`));
    const out = recordSuggestionOutcomes([], many, NOW);
    expect(out).toHaveLength(MAX_FEEDBACK_ENTRIES);
    // newest retained, oldest gone
    expect(out[out.length - 1].title).toBe(`item ${MAX_FEEDBACK_ENTRIES + 39}`);
    expect(out[0].title).toBe(`item ${40}`);
  });

  it('stays capped across repeated appends', () => {
    let log: SuggestionFeedbackEntry[] = [];
    for (let n = 0; n < MAX_FEEDBACK_ENTRIES * 3; n++) {
      log = recordSuggestionOutcomes(log, [accepted(`i${n}`)], NOW);
    }
    expect(log).toHaveLength(MAX_FEEDBACK_ENTRIES);
    expect(log[log.length - 1].title).toBe(`i${MAX_FEEDBACK_ENTRIES * 3 - 1}`);
  });

  it('caps title length (titles are model output, treat as unbounded)', () => {
    const out = recordSuggestionOutcomes([], [accepted('T'.repeat(500))], NOW);
    expect(out[0].title).toHaveLength(MAX_TITLE_CHARS);
  });

  it('collapses whitespace so a multi-line title stays one line', () => {
    const out = recordSuggestionOutcomes([], [accepted('  Lift\n\n  heavy  ')], NOW);
    expect(out[0].title).toBe('Lift heavy');
  });
});

describe('recordSuggestionOutcomes — never throws on bad input', () => {
  it('tolerates a garbage/cold existing log', () => {
    expect(recordSuggestionOutcomes(undefined, [accepted('A')], NOW)).toHaveLength(1);
    expect(recordSuggestionOutcomes(null, [accepted('A')], NOW)).toHaveLength(1);
    expect(recordSuggestionOutcomes('nope' as any, [accepted('A')], NOW)).toHaveLength(1);
    expect(recordSuggestionOutcomes({} as any, [accepted('A')], NOW)).toHaveLength(1);
  });

  it('drops corrupted entries already in the persisted log', () => {
    const dirty = [
      accepted('good'),
      null,
      { kind: 'nope', outcome: 'accepted', title: 'bad kind' },
      { kind: 'habit', outcome: 'invented', title: 'bad outcome' },
      { kind: 'habit', outcome: 'accepted' }, // no title
    ];
    const out = recordSuggestionOutcomes(dirty as any, [], NOW);
    expect(out.map((e) => e.title)).toEqual(['good']);
  });

  it('drops malformed incoming entries instead of recording them', () => {
    const out = recordSuggestionOutcomes(
      [],
      [
        accepted('kept'),
        { kind: 'habit', outcome: 'accepted', title: '   ' } as any, // blank title
        { kind: 'habit', outcome: 'accepted', title: 42 } as any, // non-string
        { outcome: 'accepted', title: 'no kind' } as any,
        { kind: 'todo', title: 'no outcome' } as any,
        null as any,
      ],
      NOW,
    );
    expect(out.map((e) => e.title)).toEqual(['kept']);
  });

  it('defaults a missing mandateId to "" rather than undefined', () => {
    const out = recordSuggestionOutcomes(
      [],
      [{ kind: 'todo', outcome: 'accepted', title: 'X' }],
      NOW,
    );
    expect(out[0].mandateId).toBe('');
  });

  it('an empty append still returns a sanitized log (used by the migrate path)', () => {
    const dirty = [accepted('good'), { kind: 'bogus' } as any];
    expect(recordSuggestionOutcomes(dirty as any, [], NOW).map((e) => e.title)).toEqual(['good']);
    expect(recordSuggestionOutcomes([], [], NOW)).toEqual([]);
    expect(recordSuggestionOutcomes([], null, NOW)).toEqual([]);
  });
});

describe('recordSuggestionOutcomes — PERSISTED rows are normalized, not just filtered', () => {
  // Greptile T-Rex (#337) reproduced this: the earlier version only FILTERED
  // existing rows, so a persisted entry could survive migration still violating
  // SuggestionFeedbackEntry. `migrate()` calls this exact function to sanitize,
  // so "survives unchanged" meant the store held invalid rows after upgrade.
  // The original tests only proved bad rows get DROPPED — never that surviving
  // rows get NORMALIZED. That gap is why it shipped.

  it('caps an overlong title that was already persisted', () => {
    const persisted = [{ kind: 'habit', outcome: 'accepted', title: 'T'.repeat(900), mandateId: 'm', at: 1 }];
    const out = recordSuggestionOutcomes(persisted as any, [], NOW);
    expect(out[0].title).toHaveLength(MAX_TITLE_CHARS);
  });

  it('collapses a multiline title that was already persisted', () => {
    const persisted = [{ kind: 'todo', outcome: 'regenerated', title: 'a\n\n  b  ', mandateId: 'm', at: 1 }];
    expect(recordSuggestionOutcomes(persisted as any, [], NOW)[0].title).toBe('a b');
  });

  it('stamps a missing or non-finite `at` on a persisted row', () => {
    const persisted = [
      { kind: 'habit', outcome: 'accepted', title: 'no at' },
      { kind: 'habit', outcome: 'accepted', title: 'nan at', at: NaN },
      { kind: 'habit', outcome: 'accepted', title: 'string at', at: 'nope' },
    ];
    const out = recordSuggestionOutcomes(persisted as any, [], NOW);
    expect(out.map((e) => e.at)).toEqual([NOW, NOW, NOW]);
  });

  it('defaults a missing mandateId on a persisted row to ""', () => {
    const persisted = [{ kind: 'todo', outcome: 'accepted', title: 'x', at: 1 }];
    expect(recordSuggestionOutcomes(persisted as any, [], NOW)[0].mandateId).toBe('');
  });

  it('every returned row satisfies the type, whatever went in (the migrate contract)', () => {
    const dirty = [
      { kind: 'habit', outcome: 'accepted', title: 'T'.repeat(500) },
      { kind: 'todo', outcome: 'regenerated', title: 'ok\nline', at: 'bad', mandateId: 7 },
      { kind: 'bogus', outcome: 'accepted', title: 'dropped' },
      null,
      { kind: 'habit', outcome: 'accepted', title: '   ' },
    ];
    const out = recordSuggestionOutcomes(dirty as any, [accepted('fresh')], NOW);
    for (const e of out) {
      expect(['habit', 'todo']).toContain(e.kind);
      expect(['accepted', 'regenerated']).toContain(e.outcome);
      expect(typeof e.title).toBe('string');
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
      expect(e.title).not.toMatch(/\s{2,}|\n/);
      expect(typeof e.mandateId).toBe('string');
      expect(Number.isFinite(e.at)).toBe(true);
    }
    expect(out.map((e) => e.title)).toEqual(['T'.repeat(MAX_TITLE_CHARS), 'ok line', 'fresh']);
  });
});
