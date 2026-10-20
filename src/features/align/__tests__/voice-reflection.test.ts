import { describe, expect, it } from 'vitest';
import {
  shouldShowVoiceReflection,
  VOICE_REFLECTION_STRINGS,
  VOICE_REFLECTION_QUESTION,
  VOICE_REFLECTION_BODY,
} from '../voice-reflection';

// NEX-211: the reflection gate + machine-checked §18 copy compliance.

describe('shouldShowVoiceReflection (NEX-211)', () => {
  it('does not show before the flag has hydrated (null)', () => {
    expect(shouldShowVoiceReflection(null)).toBe(false);
  });
  it('does not show once seen (true)', () => {
    expect(shouldShowVoiceReflection(true)).toBe(false);
  });
  it('shows once when loaded and unseen (false)', () => {
    expect(shouldShowVoiceReflection(false)).toBe(true);
  });
});

describe('voice reflection copy — §18 compliance', () => {
  it('contains no em dash and no exclamation point', () => {
    for (const s of VOICE_REFLECTION_STRINGS) {
      expect(s).not.toContain('—');
      expect(s).not.toContain('!');
    }
  });
  it('uses the declarative, non-coaching wording', () => {
    expect(VOICE_REFLECTION_QUESTION).toBe('Whose voice is this: yours, or one you inherited?');
    expect(VOICE_REFLECTION_BODY).toBe('Some voices are chosen. Some were inherited.');
    // body must not be an imperative aimed at the user (§18.2 no coaching)
    expect(VOICE_REFLECTION_BODY.toLowerCase()).not.toMatch(/\b(just notice|notice|remember|don'?t forget)\b/);
  });
});
