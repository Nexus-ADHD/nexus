import { describe, expect, it } from 'vitest';
import {
  isPlaudImportAvailable,
  PLAUD_REVIEW_CHANNEL,
} from '../access';

describe('PLAUD import access', () => {
  // Owner-approved 2026-08-15: the connector is offered everywhere. These cases
  // are the ones that used to be false, kept so a future re-gate has to change a
  // test deliberately rather than silently hide the row again.
  it('is available in ordinary production', () => {
    expect(isPlaudImportAvailable({ isDev: false, updateChannel: 'production' })).toBe(true);
  });

  it('is available with no update channel at all', () => {
    expect(isPlaudImportAvailable({ isDev: false, updateChannel: undefined })).toBe(true);
    expect(isPlaudImportAvailable({ isDev: false, updateChannel: null })).toBe(true);
  });

  it('is still available in development and on the review channel', () => {
    expect(isPlaudImportAvailable({ isDev: true, updateChannel: null })).toBe(true);
    expect(
      isPlaudImportAvailable({ isDev: false, updateChannel: PLAUD_REVIEW_CHANNEL }),
    ).toBe(true);
  });
});
