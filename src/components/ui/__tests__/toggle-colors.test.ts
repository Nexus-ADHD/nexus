import { describe, expect, it } from 'vitest';
import {
  resolveToggleColors,
  TOGGLE_DISABLED_OPACITY,
  type TogglePlatform,
} from '../toggle-colors';

const PLATFORMS: TogglePlatform[] = ['ios', 'android'];

describe('resolveToggleColors — track carries the state', () => {
  it('on when the value is true, off when false', () => {
    for (const platform of PLATFORMS) {
      expect(resolveToggleColors({ value: true, platform }).track).toBe('on');
      expect(resolveToggleColors({ value: false, platform }).track).toBe('off');
    }
  });

  it('the track is the ONLY thing that changes with value', () => {
    for (const platform of PLATFORMS) {
      const on = resolveToggleColors({ value: true, platform });
      const off = resolveToggleColors({ value: false, platform });
      // Thumb and opacity are value-independent: the thumb is a physical
      // object, and state is carried by track + position + the OS
      // announcement, never by the thumb's colour.
      expect(on.thumb).toBe(off.thumb);
      expect(on.opacity).toBe(off.opacity);
    }
  });
});

describe('resolveToggleColors — thumb policy', () => {
  // RN Switch docs: "Color of the foreground switch grip. If this is set on
  // iOS, the switch grip will lose its drop shadow." iOS already ships a white
  // thumb WITH the shadow, so the way to get a white thumb on iOS is to ask
  // for nothing at all.
  it('iOS asks for the NATIVE thumb, so the grip keeps its drop shadow', () => {
    expect(resolveToggleColors({ value: true, platform: 'ios' }).thumb).toBe('native');
    expect(resolveToggleColors({ value: false, platform: 'ios' }).thumb).toBe('native');
  });

  it('Android sets the thumb explicitly — it has no white default', () => {
    expect(resolveToggleColors({ value: true, platform: 'android' }).thumb).toBe('light');
  });

  it('the thumb never varies with disabled either', () => {
    expect(resolveToggleColors({ value: true, disabled: true, platform: 'ios' }).thumb).toBe(
      'native',
    );
    expect(
      resolveToggleColors({ value: true, disabled: true, platform: 'android' }).thumb,
    ).toBe('light');
  });
});

describe('resolveToggleColors — disabled', () => {
  it('dims the whole control rather than inventing a third palette', () => {
    for (const platform of PLATFORMS) {
      const off = resolveToggleColors({ value: true, disabled: true, platform });
      expect(off.opacity).toBe(TOGGLE_DISABLED_OPACITY);
      // Still reports its real track, so a disabled-ON switch still looks ON.
      expect(off.track).toBe('on');
    }
  });

  it('is fully opaque when enabled, and enabled is the default', () => {
    for (const platform of PLATFORMS) {
      expect(resolveToggleColors({ value: false, platform }).opacity).toBe(1);
      expect(resolveToggleColors({ value: false, disabled: false, platform }).opacity).toBe(1);
    }
  });
});
