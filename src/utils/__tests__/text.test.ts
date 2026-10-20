import { describe, expect, it } from 'vitest';
import { stripEmoji } from '../text';

describe('stripEmoji', () => {
  it('removes emoji and variation-selector residue from habit titles', () => {
    expect(stripEmoji('Clean eating 🥗')).toBe('Clean eating');
    expect(stripEmoji('Read Mantra 🕉️')).toBe('Read Mantra');
  });

  it('leaves clean strings untouched', () => {
    expect(stripEmoji('Meditation')).toBe('Meditation');
    expect(stripEmoji('Work 2 quarters ahead on renewals')).toBe(
      'Work 2 quarters ahead on renewals',
    );
  });

  it('handles empty and whitespace-only input', () => {
    expect(stripEmoji('')).toBe('');
    expect(stripEmoji('   ')).toBe('');
  });

  it('strips ZWJ-joined emoji sequences without leaving residue', () => {
    // family-of-three: 👨‍👩‍👧 = man + ZWJ + woman + ZWJ + girl
    expect(stripEmoji('Family time 👨‍👩‍👧')).toBe('Family time');
    // woman technologist: 👩‍💻 = woman + ZWJ + laptop
    expect(stripEmoji('Deep work 👩‍💻 block')).toBe('Deep work block');
  });

  it('collapses internal whitespace left behind by stripped emoji', () => {
    expect(stripEmoji('Morning 🌅 run')).toBe('Morning run');
  });

  it('coerces null and undefined to empty string', () => {
    // Guard for the `String(s ?? '')` branch — render sites occasionally
    // pass through optional fields.
    expect(stripEmoji(null as unknown as string)).toBe('');
    expect(stripEmoji(undefined as unknown as string)).toBe('');
  });
});
