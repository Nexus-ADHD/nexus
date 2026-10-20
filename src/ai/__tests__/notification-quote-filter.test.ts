import { describe, it, expect } from 'vitest';
import { isNotificationQuoteSafe, MAX_QUOTE_LEN } from '../notification-quote-filter';
import { QUOTE_SEED } from '../notification-quote-seed';

describe('isNotificationQuoteSafe — syntactic Law-C / §18 pre-screen', () => {
  it('passes a clean, declarative, on-voice line (S6)', () => {
    expect(isNotificationQuoteSafe('The next right thing is enough.')).toBe(true);
    expect(isNotificationQuoteSafe('Begin where you stand.')).toBe(true);
  });

  it('rejects em and en dashes (S1)', () => {
    expect(isNotificationQuoteSafe('Show up — even quietly.')).toBe(false);
    expect(isNotificationQuoteSafe('Begin again – today.')).toBe(false);
  });

  it('rejects exclamation points (S2)', () => {
    expect(isNotificationQuoteSafe('You showed up!')).toBe(false);
  });

  it('rejects emoji and accented / non-ASCII non-English (S3, S21)', () => {
    expect(isNotificationQuoteSafe('One small win today 🎉')).toBe(false);
    expect(isNotificationQuoteSafe('Continúa el camino hoy.')).toBe(false); // accented → non-ASCII
    expect(isNotificationQuoteSafe('Façonne ta journée.')).toBe(false); // accented → non-ASCII
    // NOTE: ASCII-only non-English (e.g. "Sigue adelante hoy.") is NOT caught here by design —
    // a deterministic filter can't detect language without accents; that's the human gate's job (S20).
  });

  it('allows curly quotes and ellipsis (the only non-ASCII permitted)', () => {
    expect(isNotificationQuoteSafe('You don’t need more than now.')).toBe(true);
    expect(isNotificationQuoteSafe('Begin, and the rest follows…')).toBe(true);
  });

  it('rejects shame / absence-counting / scolding (S4)', () => {
    expect(isNotificationQuoteSafe("You haven't shown up in a while.")).toBe(false);
    expect(isNotificationQuoteSafe('You missed yesterday.')).toBe(false);
    expect(isNotificationQuoteSafe("Don't break your streak.")).toBe(false);
    expect(isNotificationQuoteSafe('You need to do better.')).toBe(false);
    expect(isNotificationQuoteSafe('You should be further along.')).toBe(false);
    expect(isNotificationQuoteSafe('3 days gone.')).toBe(false);
  });

  it('rejects AI self-reference and dash/anonymous attribution (S21)', () => {
    expect(isNotificationQuoteSafe('As an AI, I suggest you focus.')).toBe(false);
    expect(isNotificationQuoteSafe('Stay the course -- Seneca')).toBe(false); // double-hyphen attribution
    expect(isNotificationQuoteSafe('Hold the line. - Anonymous')).toBe(false); // spaced hyphen + "anonymous"
    // NOTE: a bare "by Seneca" attribution is intentionally NOT filter-rejected (it would also reject
    // on-voice "by Sunday"); that's left to the human approval gate.
  });

  it('rejects quote marks but allows apostrophes (review fix)', () => {
    expect(isNotificationQuoteSafe('The word "ready" can be quiet.')).toBe(false); // straight double
    expect(isNotificationQuoteSafe('The word “ready” can be quiet.')).toBe(false); // curly double
    expect(isNotificationQuoteSafe('You don’t need more than now.')).toBe(true); // curly apostrophe
    expect(isNotificationQuoteSafe("You don't need more than now.")).toBe(true); // straight apostrophe
  });

  it('rejects additional shame phrasings (review hardening)', () => {
    expect(isNotificationQuoteSafe('You keep falling behind again.')).toBe(false);
    expect(isNotificationQuoteSafe('Another day lost to nothing.')).toBe(false);
    expect(isNotificationQuoteSafe('Time to prove yourself today.')).toBe(false);
    expect(isNotificationQuoteSafe('You always start over too soon.')).toBe(false);
    expect(isNotificationQuoteSafe('We keep letting ourselves down.')).toBe(false);
  });

  it('does not over-reject an on-voice line containing "by <Day>"', () => {
    expect(isNotificationQuoteSafe("Anchored by Sunday's small rep.")).toBe(true);
  });

  it('rejects over-length, empty, and too-short (S5)', () => {
    expect(isNotificationQuoteSafe('x'.repeat(MAX_QUOTE_LEN + 1))).toBe(false);
    expect(isNotificationQuoteSafe('   ')).toBe(false);
    expect(isNotificationQuoteSafe('')).toBe(false);
    expect(isNotificationQuoteSafe('Go.')).toBe(false); // < MIN_QUOTE_LEN
    expect(isNotificationQuoteSafe(undefined)).toBe(false);
    expect(isNotificationQuoteSafe(42 as unknown)).toBe(false);
  });

  it('rejects non-declarative / dangling endings (S7)', () => {
    expect(isNotificationQuoteSafe('How did today go?')).toBe(false);
    expect(isNotificationQuoteSafe('Show up and')).toBe(false);
    expect(isNotificationQuoteSafe('The work is quiet because')).toBe(false);
  });

  it('rejects a line that duplicates a known notification prompt (S21)', () => {
    const prompts = ['What would make today a win?', 'How did today go? Debrief takes 60 seconds.'];
    expect(isNotificationQuoteSafe('What would make today a win?', prompts)).toBe(false);
    expect(isNotificationQuoteSafe('What would make today a win.', prompts)).toBe(false); // punctuation-normalized
    expect(isNotificationQuoteSafe('The next right thing is enough.', prompts)).toBe(true);
  });

  it('NEX-277: rejects a question mark ANYWHERE, not just at the end', () => {
    expect(isNotificationQuoteSafe('Who shows up today? You do.')).toBe(false);
    expect(isNotificationQuoteSafe('Today is yours to begin.')).toBe(true);
  });

  it('NEX-277: rejects recall-of-a-past-promise framing (reproach risk)', () => {
    expect(isNotificationQuoteSafe('You said you are someone who ships before noon.')).toBe(false);
    expect(isNotificationQuoteSafe('You promised to move your body today.')).toBe(false);
    expect(isNotificationQuoteSafe('You committed to this practice once.')).toBe(false);
  });

  it('NEX-277: rejects obligation / accountability / scoreboard framing', () => {
    expect(isNotificationQuoteSafe('You are supposed to be further along.')).toBe(false);
    expect(isNotificationQuoteSafe('Live up to the person you describe.')).toBe(false);
    expect(isNotificationQuoteSafe('Keep your word to yourself today.')).toBe(false);
    expect(isNotificationQuoteSafe('Time to follow through on it.')).toBe(false);
    expect(isNotificationQuoteSafe('You owe yourself the work.')).toBe(false);
    expect(isNotificationQuoteSafe('Get back on track now.')).toBe(false);
  });

  it('NEX-277: allows present-tense, affirming personalized lines', () => {
    expect(isNotificationQuoteSafe('Someone who ships before noon. Today is yours to begin.')).toBe(true);
    expect(isNotificationQuoteSafe('You showed up today. Come name it.')).toBe(true);
  });

  it('NEX-277: length cap is 100 (the one-line quote format)', () => {
    expect(MAX_QUOTE_LEN).toBe(100);
    expect(isNotificationQuoteSafe('a'.repeat(95) + '.')).toBe(true); // 96 chars
    expect(isNotificationQuoteSafe('a'.repeat(101))).toBe(false);
  });

  it('every curated seed line passes the filter (the floor must be safe)', () => {
    for (const line of QUOTE_SEED) {
      expect(isNotificationQuoteSafe(line), `seed not filter-safe: "${line}"`).toBe(true);
    }
  });

  it('seed lines are unique and within length', () => {
    expect(new Set(QUOTE_SEED).size).toBe(QUOTE_SEED.length);
    for (const l of QUOTE_SEED) expect(l.length).toBeLessThanOrEqual(MAX_QUOTE_LEN);
  });
});
