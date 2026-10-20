/**
 * NEX-310 — the read side of the suggestion feedback loop.
 *
 * The properties that matter: it is bounded (the log is model-authored free
 * text), it is recency-ordered, it prefers this mandate's own history, and it
 * stays SILENT rather than speaking from noise. The silent case must leave the
 * prompt byte-identical to the pre-feature prompt.
 */
import { describe, expect, it } from 'vitest';
import {
  prepareTaste,
  formatTasteForPrompt,
  MAX_TITLES_PER_BUCKET,
  MAX_DIGEST_TITLE_CHARS,
  MAX_ENTRIES_CONSIDERED,
  MIN_ENTRIES_FOR_SIGNAL,
} from '../suggestion-taste-context';

const at = (n: number) => 1_800_000_000_000 + n * 1000;

const entry = (
  over: Partial<{
    kind: 'habit' | 'todo';
    outcome: 'accepted' | 'regenerated';
    title: string;
    mandateId: string;
    at: number;
  }> = {},
) => ({
  kind: 'habit' as const,
  outcome: 'accepted' as const,
  title: 'Lift 4x/week',
  mandateId: 'm-1',
  at: at(0),
  ...over,
});

describe('prepareTaste — silence when there is no honest signal', () => {
  it('returns nothing for empty or garbage input rather than throwing', () => {
    for (const bad of [undefined, null, 'nope', {}, [], [null, 42]]) {
      const out = prepareTaste(bad as any);
      expect(out.buckets).toEqual([]);
      expect(out.considered).toBe(0);
    }
  });

  it('drops rows that do not satisfy the entry contract', () => {
    const dirty = [
      entry(),
      { kind: 'bogus', outcome: 'accepted', title: 'x' },
      { kind: 'habit', outcome: 'invented', title: 'x' },
      { kind: 'habit', outcome: 'accepted' },
      null,
    ];
    expect(prepareTaste(dirty as any).considered).toBe(1);
  });

  it('formats to null below the signal floor, so the prompt is unchanged', () => {
    const few = Array.from({ length: MIN_ENTRIES_FOR_SIGNAL - 1 }, (_, i) =>
      entry({ title: `H${i}`, at: at(i) }),
    );
    expect(formatTasteForPrompt(few)).toBeNull();
    expect(formatTasteForPrompt([])).toBeNull();
    expect(formatTasteForPrompt(null)).toBeNull();
  });

  it('formats to null when entries exist but every title is blank', () => {
    const blank = Array.from({ length: 5 }, (_, i) => entry({ title: '   ', at: at(i) }));
    expect(formatTasteForPrompt(blank)).toBeNull();
  });
});

describe('prepareTaste — bounded', () => {
  it('caps titles per bucket', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      entry({ title: `Habit ${i}`, at: at(i) }),
    );
    const [bucket] = prepareTaste(many).buckets;
    expect(bucket.accepted).toHaveLength(MAX_TITLES_PER_BUCKET);
  });

  it('caps per-title length (titles are model output)', () => {
    const long = Array.from({ length: 4 }, (_, i) =>
      entry({ title: 'T'.repeat(500), at: at(i), mandateId: `m-${i}` }),
    );
    const [bucket] = prepareTaste(long).buckets;
    expect(bucket.accepted[0]).toHaveLength(MAX_DIGEST_TITLE_CHARS);
  });

  it('collapses whitespace so a multi-line title stays one line', () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      entry({ title: '  Lift\n\n  heavy  ', at: at(i), mandateId: `m-${i}` }),
    );
    expect(prepareTaste(rows).buckets[0].accepted[0]).toBe('Lift heavy');
  });

  it('considers at most MAX_ENTRIES_CONSIDERED, newest first', () => {
    const many = Array.from({ length: MAX_ENTRIES_CONSIDERED + 25 }, (_, i) =>
      entry({ title: `H${i}`, at: at(i) }),
    );
    expect(prepareTaste(many).considered).toBe(MAX_ENTRIES_CONSIDERED);
  });

  it('dedupes case-insensitively: the same item passed on twice is one preference', () => {
    const rows = [
      entry({ outcome: 'regenerated', title: 'Cold plunge', at: at(3) }),
      entry({ outcome: 'regenerated', title: 'COLD PLUNGE', at: at(2) }),
      entry({ outcome: 'regenerated', title: 'cold plunge', at: at(1) }),
      entry({ outcome: 'regenerated', title: 'Sauna', at: at(0) }),
    ];
    expect(prepareTaste(rows).buckets[0].declined).toEqual(['Cold plunge', 'Sauna']);
  });
});

describe('prepareTaste — recency', () => {
  it('keeps the NEWEST titles when over the bucket cap', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      entry({ title: `H${i}`, at: at(i) }),
    );
    // at() increases with i, so H11 is newest.
    expect(prepareTaste(many).buckets[0].accepted).toEqual(['H11', 'H10', 'H9', 'H8']);
  });

  it('treats a missing or non-finite `at` as oldest, never crowding out real signal', () => {
    const rows = [
      entry({ title: 'No timestamp', at: undefined as any }),
      entry({ title: 'NaN timestamp', at: NaN }),
      entry({ title: 'Real recent', at: at(50) }),
      entry({ title: 'Real older', at: at(10) }),
    ];
    const accepted = prepareTaste(rows).buckets[0].accepted;
    expect(accepted[0]).toBe('Real recent');
    expect(accepted[1]).toBe('Real older');
  });
});

describe('prepareTaste — mandate scoping', () => {
  const mixed = [
    ...Array.from({ length: 4 }, (_, i) => entry({ title: `Mine ${i}`, mandateId: 'm-1', at: at(i) })),
    ...Array.from({ length: 6 }, (_, i) => entry({ title: `Other ${i}`, mandateId: 'm-2', at: at(100 + i) })),
  ];

  it('prefers THIS mandate history when it clears the floor', () => {
    const out = prepareTaste(mixed, 'm-1');
    expect(out.mandateScoped).toBe(true);
    expect(out.buckets[0].accepted.every((t) => t.startsWith('Mine'))).toBe(true);
  });

  it('falls back to global taste when this mandate has too little history', () => {
    const out = prepareTaste(mixed, 'm-thin');
    expect(out.mandateScoped).toBe(false);
    // Global fallback is newest-first, and m-2's entries are the newest.
    expect(out.buckets[0].accepted[0]).toBe('Other 5');
  });

  it('is global when no mandateId is supplied', () => {
    expect(prepareTaste(mixed).mandateScoped).toBe(false);
  });

  it('matches ids across string/number types', () => {
    const numeric = Array.from({ length: 4 }, (_, i) =>
      entry({ title: `N${i}`, mandateId: 7 as any, at: at(i) }),
    );
    expect(prepareTaste(numeric, '7').mandateScoped).toBe(true);
  });
});

describe('formatTasteForPrompt — the rendered block', () => {
  const rows = [
    entry({ kind: 'habit', outcome: 'accepted', title: 'Lift 4x/week, 45 min', at: at(5) }),
    entry({ kind: 'habit', outcome: 'regenerated', title: 'Exercise more', at: at(4) }),
    entry({ kind: 'todo', outcome: 'accepted', title: 'Book DEXA scan', at: at(3) }),
    entry({ kind: 'todo', outcome: 'regenerated', title: 'Get healthy', at: at(2) }),
  ];

  it('separates habits from to-dos and taken from passed-on', () => {
    const out = formatTasteForPrompt(rows, 'm-1')!;
    expect(out).toContain('Habits they added: Lift 4x/week, 45 min');
    expect(out).toContain('Habits they passed on: Exercise more');
    expect(out).toContain('To-dos they added: Book DEXA scan');
    expect(out).toContain('To-dos they passed on: Get healthy');
  });

  it('says whether the signal is mandate-scoped or global', () => {
    expect(formatTasteForPrompt(rows, 'm-1')).toContain('for THIS mandate');
    expect(formatTasteForPrompt(rows)).toContain('across their mandates');
  });

  it('tells the model to read style, not to copy or blacklist', () => {
    const out = formatTasteForPrompt(rows, 'm-1')!;
    expect(out).toContain('STYLE and SCALE');
    expect(out).toContain('Do not re-suggest anything they already added');
  });

  it('never counts absences or names the user (Law C)', () => {
    const out = formatTasteForPrompt(rows, 'm-1')!.toLowerCase();
    for (const banned of ['failed', 'ignored', 'you have', "you haven't", 'rejected', 'gave up', 'streak']) {
      expect(out).not.toContain(banned);
    }
  });

  it('obeys §18.1: no em dashes, no exclamation points', () => {
    const out = formatTasteForPrompt(rows, 'm-1')!;
    expect(out).not.toMatch(/—|!/);
  });

  it('omits a bucket that has only one side of the signal', () => {
    const acceptedOnly = Array.from({ length: 4 }, (_, i) =>
      entry({ kind: 'todo', outcome: 'accepted', title: `T${i}`, at: at(i) }),
    );
    const out = formatTasteForPrompt(acceptedOnly)!;
    expect(out).toContain('To-dos they added');
    expect(out).not.toContain('they passed on');
    expect(out).not.toContain('Habits');
    // The header must not promise a signal the buckets do not carry.
    expect(out).toContain('What this person has taken across their mandates:');
  });

  it('says only "passed on" when every suggestion was regenerated away', () => {
    const declinedOnly = Array.from({ length: 4 }, (_, i) =>
      entry({ kind: 'habit', outcome: 'regenerated', title: `H${i}`, at: at(i) }),
    );
    const out = formatTasteForPrompt(declinedOnly)!;
    expect(out).toContain('What this person has passed on across their mandates:');
    expect(out).not.toContain('they added');
  });
});
