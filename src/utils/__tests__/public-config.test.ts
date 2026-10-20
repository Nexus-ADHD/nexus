import { beforeEach, describe, expect, it, vi } from 'vitest';

const extraHolder = vi.hoisted(() => ({ extra: {} as Record<string, unknown> }));

vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return { extra: extraHolder.extra };
    },
  },
}));

import { publicConfigValue, publicConfigSource } from '../public-config';

describe('publicConfigValue', () => {
  beforeEach(() => {
    extraHolder.extra = {};
  });

  it('prefers the build-time env value when present', () => {
    extraHolder.extra = { EXPO_PUBLIC_TEST_KEY: 'from-extra' };
    expect(publicConfigValue('EXPO_PUBLIC_TEST_KEY', 'from-env')).toBe('from-env');
  });

  it('falls back to app.json extra when env is undefined', () => {
    extraHolder.extra = { EXPO_PUBLIC_TEST_KEY: 'from-extra' };
    expect(publicConfigValue('EXPO_PUBLIC_TEST_KEY', undefined)).toBe('from-extra');
  });

  it('falls back to extra when env is empty or whitespace', () => {
    extraHolder.extra = { EXPO_PUBLIC_TEST_KEY: 'from-extra' };
    expect(publicConfigValue('EXPO_PUBLIC_TEST_KEY', '')).toBe('from-extra');
    expect(publicConfigValue('EXPO_PUBLIC_TEST_KEY', '   ')).toBe('from-extra');
  });

  it('returns empty string when both sources are missing', () => {
    expect(publicConfigValue('EXPO_PUBLIC_TEST_KEY', undefined)).toBe('');
  });

  it('trims values from both sources', () => {
    expect(publicConfigValue('EXPO_PUBLIC_TEST_KEY', '  padded  ')).toBe('padded');
    extraHolder.extra = { EXPO_PUBLIC_TEST_KEY: '  padded-extra  ' };
    expect(publicConfigValue('EXPO_PUBLIC_TEST_KEY', undefined)).toBe('padded-extra');
  });

  it('ignores non-string extra values', () => {
    extraHolder.extra = { EXPO_PUBLIC_TEST_KEY: 42 };
    expect(publicConfigValue('EXPO_PUBLIC_TEST_KEY', undefined)).toBe('');
  });
});

describe('publicConfigSource', () => {
  beforeEach(() => {
    extraHolder.extra = {};
  });

  it('reports env when the env value is set', () => {
    extraHolder.extra = { EXPO_PUBLIC_TEST_KEY: 'from-extra' };
    expect(publicConfigSource('EXPO_PUBLIC_TEST_KEY', 'from-env')).toBe('env');
  });

  it('reports extra when only extra has the value', () => {
    extraHolder.extra = { EXPO_PUBLIC_TEST_KEY: 'from-extra' };
    expect(publicConfigSource('EXPO_PUBLIC_TEST_KEY', undefined)).toBe('extra');
  });

  it('reports missing when neither source has the value', () => {
    expect(publicConfigSource('EXPO_PUBLIC_TEST_KEY', undefined)).toBe('missing');
  });
});
