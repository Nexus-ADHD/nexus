import { describe, expect, it } from 'vitest';
import { HABIT_CUES, shouldShowCue } from '../cue-library';

// NEX-209: the cue library + the not-started surfacing gate.

const LEADING_IMPERATIVES =
  /^(do|go|set|pick|start|make|keep|take|build|finish|plan|add|try|focus|choose|begin)\b/i;

describe('HABIT_CUES (NEX-209)', () => {
  it('is non-empty with no duplicates', () => {
    expect(HABIT_CUES.length).toBeGreaterThan(3);
    expect(new Set(HABIT_CUES).size).toBe(HABIT_CUES.length);
  });
  it('every cue is a neutral §18-clean fragment (no I/you, no em dash/exclamation, no leading imperative)', () => {
    for (const cue of HABIT_CUES) {
      expect(cue).not.toContain('—');
      expect(cue).not.toContain('!');
      // neutral — no first person "I" and no second person you/your
      expect(cue).not.toMatch(/\bI\b/);
      expect(cue.toLowerCase()).not.toMatch(/\byou\b|\byour\b/);
      expect(cue).not.toMatch(LEADING_IMPERATIVES);
    }
  });
});

describe('shouldShowCue (NEX-209)', () => {
  it('shows while a cue is set and the habit is not started', () => {
    expect(shouldShowCue('After morning coffee', 0)).toBe(true);
  });
  it('hides once the habit is started (>=1 rep), even if not fully done', () => {
    expect(shouldShowCue('After morning coffee', 1)).toBe(false);
    expect(shouldShowCue('After morning coffee', 3)).toBe(false);
  });
  it('hides for empty / whitespace / null / undefined cues', () => {
    expect(shouldShowCue('', 0)).toBe(false);
    expect(shouldShowCue('   ', 0)).toBe(false);
    expect(shouldShowCue(null, 0)).toBe(false);
    expect(shouldShowCue(undefined, 0)).toBe(false);
  });
});
