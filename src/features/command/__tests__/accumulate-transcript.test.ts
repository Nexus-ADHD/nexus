import { describe, expect, it } from 'vitest';
import { accumulateTranscript } from '../accumulate-transcript';

describe('accumulateTranscript', () => {
  it('appends a new segment after a pause (the NEX-149 case)', () => {
    // iOS restarts the recognition task on a long pause; the second isFinal
    // is a fresh segment that must be appended, not replace the first.
    const first = accumulateTranscript('', 'Wins this week I closed all my deals.');
    const second = accumulateTranscript(first, 'I improved my relationship with my family.');
    expect(second).toBe(
      'Wins this week I closed all my deals. I improved my relationship with my family.',
    );
  });

  it('accumulates across three or more segments', () => {
    let t = '';
    t = accumulateTranscript(t, 'one');
    t = accumulateTranscript(t, 'two');
    t = accumulateTranscript(t, 'three');
    expect(t).toBe('one two three');
  });

  it('replaces (does not double) when handed a cumulative transcript (NEX-80 guard)', () => {
    const committed = 'set a to-do';
    // A build that returns the full cumulative transcript: the new value
    // already contains what we committed (word-bounded), so we replace.
    const next = accumulateTranscript(committed, 'set a to-do to clean the pool');
    expect(next).toBe('set a to-do to clean the pool');
  });

  it('appends a new segment that only shares a string prefix (Greptile word-boundary)', () => {
    // committed 'go' must NOT be swallowed by a fresh segment 'going to the store'.
    expect(accumulateTranscript('go', 'going to the store')).toBe('go going to the store');
  });

  it('preserves an intentionally repeated trailing word (Codex)', () => {
    // 'yes' here is real new speech, not a recognizer re-fire — keep it.
    expect(accumulateTranscript('I said yes', 'yes')).toBe('I said yes yes');
  });

  it('ignores an exact whole-transcript re-delivery', () => {
    expect(accumulateTranscript('set a to-do', 'set a to-do')).toBe('set a to-do');
  });

  it('is a no-op for empty / whitespace-only segments', () => {
    expect(accumulateTranscript('hello', '')).toBe('hello');
    expect(accumulateTranscript('hello', '   ')).toBe('hello');
  });

  it('returns the first segment verbatim when nothing is committed yet', () => {
    expect(accumulateTranscript('', 'first words')).toBe('first words');
  });

  it('trims surrounding whitespace on incoming segments', () => {
    expect(accumulateTranscript('one', '  two  ')).toBe('one two');
  });
});
