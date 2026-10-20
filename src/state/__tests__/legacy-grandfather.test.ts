import { describe, it, expect } from 'vitest';
import {
  isActivatedBeforeReorder,
  PAYWALL_REORDER_CUTOFF_MS,
  scopedDeviceFlagKey,
  LEGACY_FREE_USER_KEY,
  LAUNCH_PAYWALL_DISMISSED_KEY,
} from '../legacy-grandfather';

const BEFORE = '2026-06-01T12:00:00.000Z'; // < cutoff
const AFTER = '2026-07-01T12:00:00.000Z';  // > cutoff

describe('isActivatedBeforeReorder', () => {
  it('flags an existing user activated before the cutoff as legacy', () => {
    expect(isActivatedBeforeReorder(BEFORE)).toBe(true);
  });

  it('does NOT flag a new user activated after the cutoff (must see the paywall)', () => {
    expect(isActivatedBeforeReorder(AFTER)).toBe(false);
  });

  it('treats a null activatedDate as legacy (migrated user — isActivated with no date)', () => {
    // The BLOCKER fix: a new user always has a freshly-stamped post-cutoff date,
    // so a missing date is unambiguously an older migrated grandfathered user.
    expect(isActivatedBeforeReorder(null)).toBe(true);
    expect(isActivatedBeforeReorder(undefined)).toBe(true);
    expect(isActivatedBeforeReorder('')).toBe(true);
  });

  it('treats an unparseable activatedDate as legacy (fail-safe, never trap an existing user)', () => {
    expect(isActivatedBeforeReorder('not-a-date')).toBe(true);
  });

  it('uses the cutoff boundary as half-open (exactly-at-cutoff is NOT before → not legacy)', () => {
    const atCutoff = new Date(PAYWALL_REORDER_CUTOFF_MS).toISOString();
    expect(isActivatedBeforeReorder(atCutoff)).toBe(false);
    expect(isActivatedBeforeReorder(new Date(PAYWALL_REORDER_CUTOFF_MS - 1).toISOString())).toBe(true);
  });

  it('honors a custom cutoff', () => {
    expect(isActivatedBeforeReorder(AFTER, Date.parse('2026-08-01T00:00:00.000Z'))).toBe(true);
  });
});

describe('scopedDeviceFlagKey (NEX-204 per-userId device flags)', () => {
  it('suffixes the base key with the uid so accounts never share a flag', () => {
    expect(scopedDeviceFlagKey(LEGACY_FREE_USER_KEY, 'user-a')).toBe('nexus_legacy_free_user:user-a');
    expect(scopedDeviceFlagKey(LAUNCH_PAYWALL_DISMISSED_KEY, 'user-b')).toBe('nexus_launch_paywall_dismissed:user-b');
  });

  it('returns distinct keys for distinct users (no cross-account leak)', () => {
    expect(scopedDeviceFlagKey(LEGACY_FREE_USER_KEY, 'a'))
      .not.toBe(scopedDeviceFlagKey(LEGACY_FREE_USER_KEY, 'b'));
  });

  it('returns null for a missing/empty uid (never writes an unscoped `base:null` key)', () => {
    expect(scopedDeviceFlagKey(LEGACY_FREE_USER_KEY, null)).toBeNull();
    expect(scopedDeviceFlagKey(LEGACY_FREE_USER_KEY, undefined)).toBeNull();
    expect(scopedDeviceFlagKey(LEGACY_FREE_USER_KEY, '')).toBeNull();
  });
});
