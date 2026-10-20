import { describe, it, expect } from 'vitest';
import {
  emptyPool,
  selectQuote,
  markShown,
  addCandidates,
  removeQuote,
  evictForMandateChange,
  shouldGenerate,
  sanitizeQuotePool,
  NO_REPEAT_DAYS,
} from '../notification-quote-pool';
import { QUOTE_SEED } from '../notification-quote-seed';

const poolWith = (live: string[]) => ({ ...emptyPool(), live });

describe('sanitizeQuotePool (corrupted-persistence guard)', () => {
  it('passes a valid pool through, filtering non-string/non-number junk', () => {
    const p = sanitizeQuotePool({
      live: ['A clean line.', 42],
      pending: ['B clean line.'],
      shown: { 'A clean line.': 3, bad: 'x' },
      lastGenAtMs: 100,
      removed: ['Old removed line.', 7],
      mandateHash: 'abc',
    });
    expect(p.live).toEqual(['A clean line.']);
    expect(p.pending).toEqual(['B clean line.']);
    expect(p.shown).toEqual({ 'A clean line.': 3 });
    expect(p.lastGenAtMs).toBe(100);
    expect(p.removed).toEqual(['Old removed line.']);
    expect(p.mandateHash).toBe('abc');
  });

  it('defaults the NEX-277 fields for a pre-NEX-277 persisted pool (no removed/mandateHash)', () => {
    const p = sanitizeQuotePool({ live: ['A clean line.'], pending: [], shown: {}, lastGenAtMs: 0 });
    expect(p.removed).toEqual([]);
    expect(p.mandateHash).toBe('');
  });

  it('returns an empty pool for unusable shapes', () => {
    expect(sanitizeQuotePool(null)).toEqual(emptyPool());
    expect(sanitizeQuotePool({ live: 'nope', pending: [], shown: {}, lastGenAtMs: 0 })).toEqual(emptyPool());
    expect(sanitizeQuotePool({ live: [], pending: [], shown: [], lastGenAtMs: 0 })).toEqual(emptyPool());
    expect(sanitizeQuotePool({ live: [], pending: [], shown: {}, lastGenAtMs: 'x' })).toEqual(emptyPool());
    expect(sanitizeQuotePool('garbage')).toEqual(emptyPool());
  });
});

describe('selectQuote — rotation, no-repeat, fallback floor', () => {
  it('is deterministic per (dayIndex, type) (S8)', () => {
    const p = poolWith([]);
    expect(selectQuote(p, 10, 'morning')).toBe(selectQuote(p, 10, 'morning'));
    expect(selectQuote(p, 10, 'evening')).toBe(selectQuote(p, 10, 'evening'));
  });

  it('never shows the same quote for morning and evening on the same day (S8)', () => {
    const p = poolWith([]); // uses the seed floor (≥2 lines)
    for (let day = 0; day < 30; day++) {
      expect(selectQuote(p, day, 'morning')).not.toBe(selectQuote(p, day, 'evening'));
    }
  });

  it('returns a safe seed line for an empty pool with no prompts (S10)', () => {
    const q = selectQuote(emptyPool(), 3, 'morning');
    expect(q).not.toBeNull();
    expect(QUOTE_SEED).toContain(q);
  });

  it('returns the TRIMMED form of an untrimmed persisted live line (review fix)', () => {
    const p = { ...emptyPool(), live: ['  A clean steady line.  '] };
    expect(selectQuote(p, 0, 'morning')).toBe('A clean steady line.');
  });

  it('falls back to the seed when every live line fails re-validation (S10/S22)', () => {
    const p = poolWith(['Show up — even quietly.', 'You missed yesterday.']); // both now-invalid
    const q = selectQuote(p, 1, 'evening');
    expect(QUOTE_SEED).toContain(q); // invalid live lines ignored, seed used
  });

  it('keeps morning≠evening even when the no-repeat window shrinks choices to 1 (S8 edge)', () => {
    let p = poolWith(['Aaa is enough today.', 'Bbb is enough today.']);
    p = markShown(p, 'Bbb is enough today.', 10); // notRecent = ['Aaa…'] at day 12
    expect(selectQuote(p, 12, 'morning')).not.toBe(selectQuote(p, 12, 'evening'));
  });

  it('returns null when no safe non-duplicate line exists (every seed is a prompt) (S10)', () => {
    // keeps prompt-filtering intact rather than fall back to a prompt-duplicate
    expect(selectQuote(emptyPool(), 3, 'morning', { knownPrompts: [...QUOTE_SEED] })).toBeNull();
  });

  it('avoids a quote shown within the no-repeat window (S9)', () => {
    // ≥3 so the window can drop one and still leave ≥2 (keeping morning≠evening intact)
    const live = ['Aaa is enough today.', 'Bbb is enough today.', 'Ccc is enough today.'];
    let p = poolWith(live);
    const first = selectQuote(p, 0, 'morning');
    p = markShown(p, first as string, 0);
    const withinWindow = selectQuote(p, NO_REPEAT_DAYS - 1, 'morning');
    expect(withinWindow).not.toBe(first);
  });
});

describe('NEX-277 auto-use: AI lines are schedulable without an approval step', () => {
  it('a filter-passing line in pending is selectable (no human gate)', () => {
    // Only AI lines are present + seed; force selection to surface one of them by
    // making EVERY candidate an AI line is impossible (seed is always merged), so we
    // assert the pending line is in the eligible set rather than guess the slot.
    const p = addCandidates(emptyPool(), ['A clean declarative line today.']);
    expect(p.pending).toContain('A clean declarative line today.');
    const seen = new Set<string>();
    for (let d = 0; d < 60; d++) {
      seen.add(selectQuote(p, d, 'morning') as string);
      seen.add(selectQuote(p, d, 'evening') as string);
    }
    expect(seen.has('A clean declarative line today.')).toBe(true);
  });

  it('addCandidates filters out unsafe lines and dedupes by trimmed value', () => {
    const p = addCandidates(emptyPool(), [
      'A clean declarative line today.',
      '  A clean declarative line today.  ', // trimmed-dup
      'You missed it!', // unsafe → dropped
    ]);
    expect(p.pending).toEqual(['A clean declarative line today.']);
  });

  it('does not re-add a line already in the seed pool', () => {
    expect(addCandidates(emptyPool(), [QUOTE_SEED[0]]).pending).toHaveLength(0);
  });

  it('treats an untrimmed persisted entry as a duplicate', () => {
    const p = { ...emptyPool(), live: ['  First clean line here.  '] };
    expect(addCandidates(p, ['First clean line here.']).pending).toHaveLength(0);
  });

  it('markShown keys on the trimmed canonical form', () => {
    const p = markShown(emptyPool(), '  Held line here.  ', 5);
    expect(p.shown['Held line here.']).toBe(5);
    expect(p.shown['  Held line here.  ']).toBeUndefined();
  });
});

describe('NEX-277 kill switch (personalized:false ⇒ curated seed floor only)', () => {
  it('ignores AI lines and only returns seed lines when personalization is off', () => {
    const p = poolWith(['Custom AI line alpha here.', 'Custom AI line beta here.']);
    for (let d = 0; d < 40; d++) {
      const m = selectQuote(p, d, 'morning', { personalized: false });
      const e = selectQuote(p, d, 'evening', { personalized: false });
      expect(QUOTE_SEED).toContain(m);
      expect(QUOTE_SEED).toContain(e);
    }
  });

  it('still surfaces an AI line when personalization is on (default)', () => {
    const p = poolWith(['Custom AI line alpha here.', 'Custom AI line beta here.']);
    const seen = new Set<string>();
    for (let d = 0; d < 60; d++) {
      seen.add(selectQuote(p, d, 'morning') as string);
      seen.add(selectQuote(p, d, 'evening') as string);
    }
    expect([...seen].some((q) => q.startsWith('Custom AI line'))).toBe(true);
  });
});

describe('NEX-277 removeQuote (tombstone) — a removed line never comes back', () => {
  it('drops a line from both arrays and blocks re-add via addCandidates', () => {
    let p = addCandidates(emptyPool(), ['A fresh clean line here.']);
    expect(p.pending).toContain('A fresh clean line here.');
    p = removeQuote(p, ['A fresh clean line here.']);
    expect(p.pending).not.toContain('A fresh clean line here.');
    expect(p.removed).toContain('A fresh clean line here.');
    // the next generation cycle re-proposes the same line — it must NOT be re-added
    p = addCandidates(p, ['A fresh clean line here.']);
    expect(p.pending).not.toContain('A fresh clean line here.');
  });

  it('excludes a removed line from selection (works on seed lines too)', () => {
    const removed = QUOTE_SEED[0];
    const p = removeQuote(emptyPool(), [removed]);
    for (let d = 0; d < 60; d++) {
      expect(selectQuote(p, d, 'morning')).not.toBe(removed);
      expect(selectQuote(p, d, 'evening')).not.toBe(removed);
    }
  });

  it('matches the canonical (trimmed) form when removing', () => {
    let p = { ...emptyPool(), live: ['First clean line here.'], pending: ['Second clean line here.'] };
    p = removeQuote(p, ['  First clean line here.  ', '  Second clean line here.  ']);
    expect(p.live).toHaveLength(0);
    expect(p.pending).toHaveLength(0);
    expect(p.removed).toContain('First clean line here.');
    expect(p.removed).toContain('Second clean line here.');
  });
});

describe('NEX-277 evictForMandateChange (staleness)', () => {
  const base = {
    ...emptyPool(),
    live: ['L line here today.'],
    pending: ['P line here today.'],
    shown: { 'L line here today.': 1 },
    removed: ['Old removed line.'],
    mandateHash: 'old',
  };

  it('clears AI lines when the hash changes, preserving shown/removed/seed', () => {
    const e = evictForMandateChange(base, 'new');
    expect(e.live).toEqual([]);
    expect(e.pending).toEqual([]);
    expect(e.shown).toEqual({ 'L line here today.': 1 });
    expect(e.removed).toEqual(['Old removed line.']);
    expect(e.mandateHash).toBe('new');
    // seed floor still available after eviction
    expect(QUOTE_SEED).toContain(selectQuote(e, 3, 'morning'));
  });

  it('is a no-op when the hash is unchanged', () => {
    expect(evictForMandateChange(base, 'old')).toBe(base);
  });
});

describe('shouldGenerate throttle (S24)', () => {
  const opts = { targetPoolSize: 20, cooldownMs: 60_000 };
  it('generates when the pool is low and the cooldown elapsed', () => {
    expect(shouldGenerate({ ...emptyPool(), lastGenAtMs: 0 }, 100_000, opts)).toBe(true);
  });
  it('does not generate when the pool is already full enough', () => {
    const full = {
      ...emptyPool(),
      live: Array.from({ length: 20 }, (_, i) => `Quiet steady line number ${i}.`),
    };
    expect(shouldGenerate(full, 100_000, opts)).toBe(false);
  });
  it('does not generate within the cooldown window', () => {
    expect(shouldGenerate({ ...emptyPool(), lastGenAtMs: 90_000 }, 100_000, opts)).toBe(false);
  });
  it('counts UNIQUE lines, so 20 copies of one quote still triggers a refill (review fix)', () => {
    const o = { targetPoolSize: 5, cooldownMs: 0 };
    const dupes = { ...emptyPool(), live: Array.from({ length: 20 }, () => 'The same clean line here.') };
    expect(shouldGenerate(dupes, 100_000, o)).toBe(true); // 1 unique usable line < 5
  });

  it('counts only filter-passing lines, so a stale-invalid pool still refills (review fix)', () => {
    const o = { targetPoolSize: 3, cooldownMs: 0 };
    const stale = {
      ...emptyPool(),
      live: ['Good clean line today.', 'You should do better.', 'You missed it.'], // 1 usable, 2 invalid
    };
    expect(shouldGenerate(stale, 100_000, o)).toBe(true);
    const full = {
      ...emptyPool(),
      live: ['Aaa is enough now.', 'Bbb is enough now.', 'Ccc is enough now.'],
    };
    expect(shouldGenerate(full, 100_000, o)).toBe(false);
  });

  it('does not count tombstoned lines toward the pool size (review)', () => {
    const o = { targetPoolSize: 3, cooldownMs: 0 };
    const p = {
      ...emptyPool(),
      live: ['Aaa is enough now.', 'Bbb is enough now.', 'Ccc is enough now.'],
      removed: ['Aaa is enough now.', 'Bbb is enough now.'], // 2 of 3 tombstoned → 1 usable < 3
    };
    expect(shouldGenerate(p, 100_000, o)).toBe(true);
  });
});
