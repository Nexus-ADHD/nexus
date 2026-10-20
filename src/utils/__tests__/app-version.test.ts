import { describe, expect, it } from 'vitest';
import { formatAppVersion, formatUpdateId } from '../app-version';

describe('formatAppVersion', () => {
  it('joins version and build', () => {
    expect(formatAppVersion('2.1', '254')).toBe('2.1 (254)');
  });
  it('falls back when a part is missing', () => {
    expect(formatAppVersion('2.1', null)).toBe('2.1');
    expect(formatAppVersion(null, '254')).toBe('build 254');
    expect(formatAppVersion(null, undefined)).toBe('unknown');
    expect(formatAppVersion('  ', '')).toBe('unknown');
  });
});

describe('formatUpdateId', () => {
  it('shortens an OTA id', () => {
    expect(formatUpdateId('ddb9f75f-b6ed-4bfa-a78d-a8da99dc3f75')).toBe('ddb9f75f');
  });
  it('is null with no update', () => {
    expect(formatUpdateId(null)).toBeNull();
    expect(formatUpdateId('')).toBeNull();
  });
});
