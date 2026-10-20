import { describe, expect, it } from 'vitest';
import { shouldShowFirstStep, STARTED_ACK } from '../habit-first-step';

// NEX-208: the first-step gate + §18 machine-check on the app-owned constant.

describe('shouldShowFirstStep (NEX-208)', () => {
  it('shows when a non-blank first step is set and the habit is not done', () => {
    expect(shouldShowFirstStep('put on shoes', false)).toBe(true);
  });
  it('hides once the habit is done', () => {
    expect(shouldShowFirstStep('put on shoes', true)).toBe(false);
  });
  it('hides for empty / whitespace-only / null / undefined first steps', () => {
    expect(shouldShowFirstStep('', false)).toBe(false);
    expect(shouldShowFirstStep('   ', false)).toBe(false);
    expect(shouldShowFirstStep(null, false)).toBe(false);
    expect(shouldShowFirstStep(undefined, false)).toBe(false);
  });
});

describe('STARTED_ACK — §18 compliance', () => {
  it('is declarative with no em dash and no exclamation', () => {
    expect(STARTED_ACK).toBe('Started.');
    expect(STARTED_ACK).not.toContain('—');
    expect(STARTED_ACK).not.toContain('!');
  });
});
