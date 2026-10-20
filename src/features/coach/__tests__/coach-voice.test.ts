import { describe, expect, it } from 'vitest';
import { COACH_SPEECH_RATE, pickCoachVoice } from '../coach-voice';

const v = (identifier: string, name: string, quality: string | undefined, language: string) => ({ identifier, name, quality, language });

describe('pickCoachVoice', () => {
  it('prefers a Premium voice in the exact locale over Enhanced and Default', () => {
    const voices = [
      v('com.apple.voice.compact.en-US.Samantha', 'Samantha', 'Default', 'en-US'),
      v('com.apple.voice.enhanced.en-US.Samantha', 'Samantha', 'Enhanced', 'en-US'),
      v('com.apple.voice.premium.en-US.Zoe', 'Zoe', 'Premium', 'en-US'),
      v('com.apple.voice.premium.en-GB.Jamie', 'Jamie', 'Premium', 'en-GB'),
    ];
    expect(pickCoachVoice(voices, 'en-US')).toBe('com.apple.voice.premium.en-US.Zoe');
  });

  it('falls to the same language when the exact locale has only Default quality, en-US ahead of other regions', () => {
    const voices = [
      v('compact.en-AU', 'Karen', 'Default', 'en-AU'),
      v('enhanced.en-GB', 'Daniel', 'Enhanced', 'en-GB'),
      v('enhanced.en-US', 'Samantha', 'Enhanced', 'en-US'),
    ];
    expect(pickCoachVoice(voices, 'en-AU')).toBe('enhanced.en-US');
  });

  it('never picks a novelty voice, however good its quality reads', () => {
    const voices = [
      v('novelty.en-US.Zarvox', 'Zarvox', 'Premium', 'en-US'),
      v('novelty.en-US.Bells', 'Bells', 'Enhanced', 'en-US'),
      v('enhanced.en-US.Ava', 'Ava', 'Enhanced', 'en-US'),
    ];
    expect(pickCoachVoice(voices, 'en-US')).toBe('enhanced.en-US.Ava');
  });

  it('returns null when only Default-quality voices exist (the OS pick is as good) or the language is absent', () => {
    expect(pickCoachVoice([v('compact.en-US', 'Samantha', 'Default', 'en-US')], 'en-US')).toBeNull();
    expect(pickCoachVoice([v('enhanced.fr-FR', 'Thomas', 'Enhanced', 'fr-FR')], 'en-US')).toBeNull();
    expect(pickCoachVoice([], 'en-US')).toBeNull();
  });

  it('is stable: equal candidates resolve by name, and malformed entries are skipped', () => {
    const voices = [
      v('enhanced.en-US.Nicky', 'Nicky', 'Enhanced', 'en-US'),
      v('enhanced.en-US.Ava', 'Ava', 'Enhanced', 'en-US'),
      { identifier: '', name: 'Broken', quality: 'Premium', language: 'en-US' },
    ];
    expect(pickCoachVoice(voices, 'en-US')).toBe('enhanced.en-US.Ava');
    expect(pickCoachVoice([...voices].reverse(), 'en-US')).toBe('enhanced.en-US.Ava');
  });

  it('reads Premium off the identifier when the SDK reports it as Default (expo-speech 14 maps only Enhanced)', () => {
    const voices = [
      v('com.apple.voice.enhanced.en-US.Samantha', 'Samantha', 'Enhanced', 'en-US'),
      v('com.apple.voice.premium.en-US.Zoe', 'Zoe', 'Default', 'en-US'),
      v('com.apple.voice.compact.en-US.Samantha', 'Samantha', 'Default', 'en-US'),
    ];
    expect(pickCoachVoice(voices, 'en-US')).toBe('com.apple.voice.premium.en-US.Zoe');
    // A Siri-style suffix counts too; a compact identifier with Default quality stays Default.
    expect(pickCoachVoice([v('com.apple.siri.voice.en-US_premium', 'Siri', 'Default', 'en-US')], 'en-US')).toBe('com.apple.siri.voice.en-US_premium');
    expect(pickCoachVoice([v('com.apple.voice.compact.en-US.Samantha', 'Samantha', 'Default', 'en-US')], 'en-US')).toBeNull();
  });

  it('speaks a touch under normal rate', () => {
    expect(COACH_SPEECH_RATE).toBeGreaterThan(0.9);
    expect(COACH_SPEECH_RATE).toBeLessThan(1);
  });
});
