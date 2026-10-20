import { describe, expect, it } from 'vitest';
import {
  displayInboxStatus,
  INBOX_OPEN_AFTER_MS,
  type InboxDisplayStatus,
} from '../display-status';

const NOW = 1_700_000_000_000;
const fresh = NOW - 60_000;
const old = NOW - INBOX_OPEN_AFTER_MS - 60_000;

const DISPLAY_VALUES: InboxDisplayStatus[] = ['NEW', 'OPEN', 'SCHEDULED', 'ARCHIVED'];

describe('displayInboxStatus', () => {
  it('never leaks an internal identifier to the screen', () => {
    // The regression this file exists for. UNPROCESSED is written by voice
    // capture, the onboarding first win, and the Inbox composer, and used to
    // render verbatim once status became visible text.
    expect(displayInboxStatus({ status: 'UNPROCESSED', createdAt: fresh }, NOW)).toBe('NEW');
  });

  it('treats UNPROCESSED as untriaged, so it ages to OPEN like NEW', () => {
    expect(displayInboxStatus({ status: 'UNPROCESSED', createdAt: old }, NOW)).toBe('OPEN');
    expect(displayInboxStatus({ status: 'NEW', createdAt: old }, NOW)).toBe('OPEN');
  });

  it('keeps a fresh untriaged item NEW', () => {
    expect(displayInboxStatus({ status: 'NEW', createdAt: fresh }, NOW)).toBe('NEW');
    expect(displayInboxStatus({ status: undefined, createdAt: fresh }, NOW)).toBe('NEW');
  });

  it('does not age terminal states', () => {
    expect(displayInboxStatus({ status: 'ARCHIVED', createdAt: old }, NOW)).toBe('ARCHIVED');
    expect(displayInboxStatus({ status: 'SCHEDULED', createdAt: old }, NOW)).toBe('SCHEDULED');
  });

  it('keeps OPEN even with no createdAt to age from', () => {
    expect(displayInboxStatus({ status: 'OPEN' }, NOW)).toBe('OPEN');
  });

  it('uses the boundary exclusively — exactly 24h old is still NEW', () => {
    expect(displayInboxStatus({ status: 'NEW', createdAt: NOW - INBOX_OPEN_AFTER_MS }, NOW)).toBe('NEW');
    expect(
      displayInboxStatus({ status: 'NEW', createdAt: NOW - INBOX_OPEN_AFTER_MS - 1 }, NOW),
    ).toBe('OPEN');
  });

  it('is case and whitespace insensitive on persisted values', () => {
    expect(displayInboxStatus({ status: '  archived ' }, NOW)).toBe('ARCHIVED');
    expect(displayInboxStatus({ status: 'unprocessed', createdAt: fresh }, NOW)).toBe('NEW');
  });

  // The contract that matters: whatever goes in, what comes out is always one
  // of the four display words. "Drops garbage" and "normalizes keepers" are
  // different properties, and only asserting the first is how the original
  // shipped.
  it.each([
    'UNPROCESSED',
    'PENDING',
    'some_future_status',
    '',
    '   ',
    'null',
  ])('maps unrecognised value %j to a display word', (status) => {
    const out = displayInboxStatus({ status, createdAt: fresh }, NOW);
    expect(DISPLAY_VALUES).toContain(out);
  });

  it.each([
    [null],
    [undefined],
    [123 as unknown as string],
    [{} as unknown as string],
  ])('survives a non-string status (%j) without leaking it', (status) => {
    const out = displayInboxStatus({ status: status as string | null | undefined }, NOW);
    expect(DISPLAY_VALUES).toContain(out);
  });

  it('survives a non-finite createdAt', () => {
    expect(displayInboxStatus({ status: 'NEW', createdAt: NaN }, NOW)).toBe('NEW');
    expect(displayInboxStatus({ status: 'NEW', createdAt: Infinity }, NOW)).toBe('NEW');
  });
});
