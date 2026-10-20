import { describe, it, expect } from 'vitest';
import { INSPIRE_SCREENS } from '../onboarding';

// NEX-17 regression guard. The original bug was a stray reference to a
// deleted INSPIRE_SCREENS constant inside the inspire-phase render
// block, crashing onboarding at runtime. The defense here is one layer
// deeper than render: assert the screens array is non-empty and
// well-formed, so the data the render path depends on can't quietly
// disappear or get malformed.
describe('INSPIRE_SCREENS', () => {
  it('is a non-empty, well-formed screen array', () => {
    expect(Array.isArray(INSPIRE_SCREENS)).toBe(true);
    expect(INSPIRE_SCREENS.length).toBeGreaterThan(0);

    for (const screen of INSPIRE_SCREENS) {
      // Every screen needs icon + accent — the InspireScreen renderer
      // reads both unconditionally.
      expect(typeof screen.icon).toBe('string');
      expect(screen.icon.length).toBeGreaterThan(0);
      expect(typeof screen.accent).toBe('string');
      expect(screen.accent).toMatch(/^#[0-9A-Fa-f]{3,8}$/);

      // Every screen needs at least one of the three content shapes
      // the renderer branches on (quote / headline / cta).
      const hasContent =
        typeof screen.quote === 'string' ||
        typeof screen.headline === 'string' ||
        screen.cta === true;
      expect(hasContent).toBe(true);
    }

    // The final screen is the CTA — advanceInspire uses `isLast` to
    // hand off to the notif phase, so the last screen must carry the
    // cta flag.
    const last = INSPIRE_SCREENS[INSPIRE_SCREENS.length - 1];
    expect(last.cta).toBe(true);
  });
});
