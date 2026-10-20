import { describe, expect, it } from 'vitest';
import { cardSurface } from '../card-surface';

const palette = {
  surface: 'S',
  surfaceElevated: 'SE',
  surfaceOpaque: 'SO',
  surfaceElevatedOpaque: 'SEO',
};

describe('cardSurface', () => {
  it('translucent default: rest=surface, pressed=surfaceElevated', () => {
    expect(cardSurface('default', false, palette)).toEqual({ rest: 'S', pressed: 'SE' });
  });

  it('translucent elevated: rest=pressed=surfaceElevated', () => {
    expect(cardSurface('elevated', false, palette)).toEqual({ rest: 'SE', pressed: 'SE' });
  });

  it('reduce-transparency default: BOTH endpoints opaque (no flash-to-translucent on press)', () => {
    const { rest, pressed } = cardSurface('default', true, palette);
    expect(rest).toBe('SO');
    expect(pressed).toBe('SEO');
  });

  it('reduce-transparency elevated: rest=pressed=elevated-opaque', () => {
    expect(cardSurface('elevated', true, palette)).toEqual({ rest: 'SEO', pressed: 'SEO' });
  });

  it('under reduce-transparency, neither endpoint is ever a translucent value', () => {
    for (const variant of ['default', 'elevated'] as const) {
      const { rest, pressed } = cardSurface(variant, true, palette);
      expect([rest, pressed]).not.toContain('S');
      expect([rest, pressed]).not.toContain('SE');
    }
  });
});
