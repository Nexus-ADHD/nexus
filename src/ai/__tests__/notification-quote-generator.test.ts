import { describe, it, expect } from 'vitest';
import { emptyPool } from '../notification-quote-pool';
import { generateInto, parseQuoteLines, buildQuotePrompt } from '../notification-quote-generator';

const opts = { targetPoolSize: 20, cooldownMs: 60_000, count: 8 };

describe('parseQuoteLines', () => {
  it('strips numbering, bullets, and wrapping quotes', () => {
    const raw = `1. The next right thing is enough.\n- Begin where you stand.\n"Stillness counts too."\n\n  • Return is always available.`;
    expect(parseQuoteLines(raw)).toEqual([
      'The next right thing is enough.',
      'Begin where you stand.',
      'Stillness counts too.',
      'Return is always available.',
    ]);
  });
  it('strips curly single-quote and curly double-quote wrappers (review fix)', () => {
    expect(parseQuoteLines('‘The next right thing is enough.’')).toEqual([
      'The next right thing is enough.',
    ]);
    expect(parseQuoteLines('“Begin where you stand.”')).toEqual(['Begin where you stand.']);
  });

  it('returns [] for non-string', () => {
    expect(parseQuoteLines(undefined)).toEqual([]);
    expect(parseQuoteLines(null)).toEqual([]);
  });
});

describe('buildQuotePrompt', () => {
  it('encodes the hard voice rules', () => {
    const p = buildQuotePrompt(8).toLowerCase();
    expect(p).toContain('no exclamation');
    expect(p).toContain('no em dash');
    expect(p).toContain('no shame');
    expect(p).toContain('streak');
  });

  it('NEX-277: bans recall + question framing and asks for present-tense momentum', () => {
    const p = buildQuotePrompt(8).toLowerCase();
    expect(p).toContain('no question marks');
    expect(p).toContain('never recall a past promise');
    expect(p).toContain('obligation');
    expect(p).toContain('present-tense');
    expect(p).toContain('under 100 characters');
  });

  it('NEX-277: injects mandates only when provided, never verbatim-paste', () => {
    const plain = buildQuotePrompt(8);
    expect(plain).not.toContain('stated these identities');

    const p = buildQuotePrompt(8, ['I am someone who ships before noon', '   ', 'I move my body daily']);
    expect(p).toContain('stated these identities');
    expect(p).toContain('- I am someone who ships before noon');
    expect(p).toContain('- I move my body daily');
    expect(p).not.toContain('-    '); // blank mandate dropped
    expect(p.toLowerCase()).toContain('never paste a statement verbatim');
  });
});

describe('generateInto', () => {
  it('puts filter-passing lines in PENDING, drops the rest, never touches live (S11)', async () => {
    const chat = async () =>
      [
        'The work is quiet today.', // clean → pending
        'You missed yesterday!', // shame + ! → dropped
        'Show up — even quietly.', // em dash → dropped
      ].join('\n');
    const p = await generateInto(emptyPool(), { chat, nowMs: 1_000_000 }, opts);
    expect(p.pending).toContain('The work is quiet today.');
    expect(p.pending).toHaveLength(1);
    expect(p.live).toHaveLength(0);
    expect(p.lastGenAtMs).toBe(1_000_000);
  });

  it('on chat failure: no crash, pool unchanged except lastGenAtMs (S12)', async () => {
    const chat = async () => {
      throw new Error('proxy 401');
    };
    const start = emptyPool();
    const p = await generateInto(start, { chat, nowMs: 2_000_000 }, opts);
    expect(p.pending).toHaveLength(0);
    expect(p.live).toHaveLength(0);
    expect(p.lastGenAtMs).toBe(2_000_000);
  });

  it('skips generation (no chat call) when throttle says no', async () => {
    let called = false;
    const chat = async () => {
      called = true;
      return 'x';
    };
    const full = {
      ...emptyPool(),
      live: Array.from({ length: 20 }, (_, i) => `Quiet steady line number ${i}.`),
    };
    const p = await generateInto(full, { chat, nowMs: 9_000_000 }, opts);
    expect(called).toBe(false);
    expect(p).toBe(full); // unchanged reference
  });
});
