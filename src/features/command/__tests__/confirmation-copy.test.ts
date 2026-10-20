import { describe, it, expect } from 'vitest';
import { locationLine, titleCaseCategory, type CaptureSurface } from '../confirmation-copy';

describe('locationLine', () => {
  it('maps each in-app surface to its present-tense location line', () => {
    expect(locationLine('home_today')).toBe('On your Home, under Today.');
    expect(locationLine('inbox')).toBe('In your Inbox.');
    expect(locationLine('orbit')).toBe('On your Orbit schedule.');
    expect(locationLine('calendar')).toBe('On your Apple Calendar.');
  });

  it('Title-cases the align category (never an all-caps shout)', () => {
    expect(locationLine('align', { category: 'BUSINESS' })).toBe('In Align, under Business.');
    expect(locationLine('align', { category: 'vision' })).toBe('In Align, under Vision.');
    expect(locationLine('align', { category: 'Personal' })).toBe('In Align, under Personal.');
  });

  it('defaults align category to Business when missing', () => {
    expect(locationLine('align')).toBe('In Align, under Business.');
    expect(locationLine('align', { category: '' })).toBe('In Align, under Business.');
    expect(locationLine('align', { category: null })).toBe('In Align, under Business.');
  });

  it('returns null for an unknown/absent surface so the caller can fall back', () => {
    expect(locationLine(undefined)).toBeNull();
    expect(locationLine('system' as unknown as CaptureSurface)).toBeNull();
  });

  it('obeys the §18.1 copy bans on every surface line', () => {
    const surfaces: CaptureSurface[] = ['home_today', 'inbox', 'orbit', 'align', 'calendar'];
    for (const s of surfaces) {
      const line = locationLine(s, { category: 'VISION' })!;
      expect(line).not.toContain('—'); // no em dash
      expect(line).not.toContain('!'); // no exclamation point
      expect(line.endsWith('.')).toBe(true); // declarative ending
    }
  });
});

describe('titleCaseCategory', () => {
  it('normalizes casing and falls back to Business', () => {
    expect(titleCaseCategory('BUSINESS')).toBe('Business');
    expect(titleCaseCategory('vIsIoN')).toBe('Vision');
    expect(titleCaseCategory(undefined)).toBe('Business');
    expect(titleCaseCategory('  ')).toBe('Business');
  });
});
