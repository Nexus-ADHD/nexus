/**
 * NEX-307 — mandate notes reach prompts, bounded.
 *
 * Notes are user-authored, arbitrarily long, multi-line, and arrive from cloud
 * sync, so every consumer must get them capped and count-limited. These tests
 * pin that contract.
 */
import { describe, expect, it } from 'vitest';
import {
  prepareMandates,
  resolveMandateFields,
  formatMandatesForPrompt,
  capNoteForPrompt,
  MAX_MANDATES,
  MAX_TITLE_CHARS,
  MAX_NOTE_CHARS,
} from '../mandate-prompt-context';

describe('prepareMandates', () => {
  it('returns [] for empty/garbage input rather than throwing', () => {
    expect(prepareMandates(null)).toEqual([]);
    expect(prepareMandates(undefined)).toEqual([]);
    expect(prepareMandates([])).toEqual([]);
    expect(prepareMandates('nope' as any)).toEqual([]);
    expect(prepareMandates([null, undefined] as any)).toEqual([]);
  });

  it('drops completed pillars and untitled ones', () => {
    const out = prepareMandates([
      { title: 'Kept', notes: 'why' },
      { title: 'Done already', completed: true },
      { title: '   ', notes: 'blank title' },
      { notes: 'no title at all' },
    ]);
    expect(out.map((m) => m.title)).toEqual(['Kept']);
  });

  it('caps the mandate COUNT', () => {
    const many = Array.from({ length: MAX_MANDATES + 8 }, (_, n) => ({
      title: `Mandate ${n}`,
      notes: 'why',
    }));
    const out = prepareMandates(many);
    expect(out).toHaveLength(MAX_MANDATES);
    expect(out[0].title).toBe('Mandate 0'); // input order preserved
  });

  it('caps title and note LENGTH (untrusted free text)', () => {
    const out = prepareMandates([
      { title: 'T'.repeat(500), notes: 'N'.repeat(5000) },
    ]);
    expect(out[0].title).toHaveLength(MAX_TITLE_CHARS);
    expect(out[0].notes).toHaveLength(MAX_NOTE_CHARS);
  });

  it('collapses newlines and runs of whitespace (notes are multi-line)', () => {
    const out = prepareMandates([
      { title: 'Be present', notes: 'line one\n\n  line two\t\tline three  ' },
    ]);
    expect(out[0].notes).toBe('line one line two line three');
    expect(out[0].notes).not.toContain('\n');
  });

  it('treats a missing/blank note as empty, not undefined', () => {
    const out = prepareMandates([
      { title: 'A' },
      { title: 'B', notes: '   \n  ' },
      { title: 'C', notes: 123 as any },
    ]);
    expect(out.map((m) => m.notes)).toEqual(['', '', '']);
  });

  it('honors per-call cap overrides', () => {
    const out = prepareMandates(
      [{ title: 'Long title here', notes: 'Long note here' }],
      { maxTitleChars: 4, maxNoteChars: 4, maxMandates: 1 },
    );
    expect(out[0].title).toBe('Long');
    expect(out[0].notes).toBe('Long');
  });
});

describe('formatMandatesForPrompt', () => {
  it('renders title, category and the why on one line each', () => {
    const text = formatMandatesForPrompt([
      { title: 'Be present with my family', category: 'PERSONAL', notes: 'Picks up the family thread.' },
      { title: 'Build something worth my name', category: 'BUSINESS' },
    ]);
    expect(text).toBe(
      '- Be present with my family (PERSONAL) — why: Picks up the family thread.\n' +
        '- Build something worth my name (BUSINESS)',
    );
  });

  it('omits the category parens when there is no category', () => {
    expect(formatMandatesForPrompt([{ title: 'Solo' }])).toBe('- Solo');
  });

  it("returns '' when there is nothing to say, so callers can omit the block", () => {
    expect(formatMandatesForPrompt([])).toBe('');
    expect(formatMandatesForPrompt(null)).toBe('');
    expect(formatMandatesForPrompt([{ completed: true, title: 'Done' }])).toBe('');
  });

  it('never emits an unbounded block', () => {
    const many = Array.from({ length: 50 }, (_, n) => ({
      title: `T${n} `.repeat(200),
      notes: `N${n} `.repeat(2000),
    }));
    const text = formatMandatesForPrompt(many);
    expect(text.split('\n')).toHaveLength(MAX_MANDATES);
    // Generous ceiling: per line = title + note + framing, times MAX_MANDATES.
    expect(text.length).toBeLessThan(MAX_MANDATES * (MAX_TITLE_CHARS + MAX_NOTE_CHARS + 60));
  });
});

describe('capNoteForPrompt (single-mandate path, used by Strengthen)', () => {
  it('caps, collapses whitespace, and returns "" for absent notes', () => {
    expect(capNoteForPrompt('  a\n\nb  ')).toBe('a b');
    expect(capNoteForPrompt(undefined)).toBe('');
    expect(capNoteForPrompt(null)).toBe('');
    expect(capNoteForPrompt(42 as any)).toBe('');
    expect(capNoteForPrompt('N'.repeat(9999))).toHaveLength(MAX_NOTE_CHARS);
  });

  it('drives the empty-state nudge: blank note reads falsy', () => {
    // The Strengthen panel renders "Suggestions get sharper once this mandate
    // has a why." on exactly this condition.
    expect(Boolean(capNoteForPrompt('   \n '))).toBe(false);
    expect(Boolean(capNoteForPrompt('because it matters'))).toBe(true);
  });
});

describe('resolveMandateFields — the ref is identity, the store is truth (#336)', () => {
  // Greptile T-Rex reproduced this twice on #336, from opposite directions:
  // putting `notes` on the ref spent an AI call per note save; narrowing the
  // fetch to the id alone then left title/category stale on the closed-over
  // object. Reading every field live by id is what closes both.

  const pillars = [
    { id: 'm-1', title: 'New title', category: 'VISION', notes: '  the   why  ' },
    { id: 'm-2', title: 'Other', category: 'PERSONAL' },
  ];

  it('prefers the CURRENT title over a stale ref (the rename case)', () => {
    const out = resolveMandateFields(pillars, { id: 'm-1', title: 'Old title', category: 'BUSINESS' });
    expect(out.title).toBe('New title');
  });

  it('prefers the CURRENT category over a stale ref (the re-category case)', () => {
    const out = resolveMandateFields(pillars, { id: 'm-1', title: 'Old title', category: 'BUSINESS' });
    expect(out.category).toBe('VISION');
  });

  it('normalizes and caps the note, never returning it raw', () => {
    const out = resolveMandateFields(pillars, { id: 'm-1' });
    expect(out.notes).toBe('the why');

    const long = [{ id: 'x', title: 't', notes: 'N'.repeat(5000) }];
    expect(resolveMandateFields(long, { id: 'x' }).notes).toHaveLength(MAX_NOTE_CHARS);
  });

  it('returns "" for notes when the pillar has none', () => {
    expect(resolveMandateFields(pillars, { id: 'm-2' }).notes).toBe('');
  });

  it('falls back to the ref when the pillar was deleted mid-sheet', () => {
    const out = resolveMandateFields(pillars, { id: 'gone', title: 'Kept', category: 'BUSINESS' });
    expect(out).toEqual({ title: 'Kept', category: 'BUSINESS', notes: '' });
  });

  it('falls back PER FIELD, so a partial pillar still contributes what it has', () => {
    const partial = [{ id: 'p', title: 'Live title' }];
    const out = resolveMandateFields(partial, { id: 'p', title: 'Stale', category: 'BUSINESS' });
    expect(out.title).toBe('Live title');
    expect(out.category).toBe('BUSINESS'); // pillar has none; ref's survives
  });

  it('never throws on garbage pillars or a ref with no id', () => {
    for (const bad of [null, undefined, 'nope', {}, [null], [{ id: null }]]) {
      expect(() => resolveMandateFields(bad as any, { id: 'm-1', title: 'T', category: 'C' })).not.toThrow();
    }
    expect(resolveMandateFields(pillars, {})).toEqual({ title: '', category: '', notes: '' });
    expect(resolveMandateFields(pillars, { title: 'T', category: 'C' }))
      .toEqual({ title: 'T', category: 'C', notes: '' });
  });

  it('matches ids across string/number types (store ids are not always strings)', () => {
    const numeric = [{ id: 7, title: 'Seven', category: 'VISION' }];
    expect(resolveMandateFields(numeric, { id: '7', title: 'Stale' }).title).toBe('Seven');
  });
});
