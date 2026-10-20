// Unit tests for the cloud-sync clock guard (Phase 1: iPad/desktop support).
// decideInbound / decideOutbound are the pure decision core of the
// last-write-wins-BY-CLOCK guard; the AsyncStorage helpers are covered with a
// mocked AsyncStorage (same pattern as supabase-guard.test.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
    removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
  },
}));

import {
  decideInbound,
  decideOutbound,
  getLastSeenCloudUpdatedAt,
  nextWriteToken,
  outboundResult,
  setLastSeenCloudUpdatedAt,
} from '../cloud-sync-guard';

const T1 = '2026-08-25T10:00:00.000Z';
const T2 = '2026-08-25T11:00:00.000Z'; // newer than T1

beforeEach(() => {
  store.map.clear();
});

describe('decideInbound', () => {
  it('always merges onto an empty install (NEX-142 seed path)', () => {
    expect(decideInbound({ cloudUpdatedAt: T1, lastSeenUpdatedAt: T2, localIsEmpty: true })).toBe('merge');
    expect(decideInbound({ cloudUpdatedAt: null, lastSeenUpdatedAt: null, localIsEmpty: true })).toBe('merge');
  });

  it('merges a populated install when the cloud row is newer than last seen', () => {
    expect(decideInbound({ cloudUpdatedAt: T2, lastSeenUpdatedAt: T1, localIsEmpty: false })).toBe('merge');
  });

  it('keeps local when the cloud row is not newer (equal or older)', () => {
    expect(decideInbound({ cloudUpdatedAt: T1, lastSeenUpdatedAt: T1, localIsEmpty: false })).toBe('keep-local');
    expect(decideInbound({ cloudUpdatedAt: T1, lastSeenUpdatedAt: T2, localIsEmpty: false })).toBe('keep-local');
  });

  it('keeps local when there is no clock baseline (upgrade path)', () => {
    expect(decideInbound({ cloudUpdatedAt: T2, lastSeenUpdatedAt: null, localIsEmpty: false })).toBe('keep-local');
    expect(decideInbound({ cloudUpdatedAt: null, lastSeenUpdatedAt: T1, localIsEmpty: false })).toBe('keep-local');
  });

  it('keeps local on unparseable timestamps', () => {
    expect(decideInbound({ cloudUpdatedAt: 'not-a-date', lastSeenUpdatedAt: T1, localIsEmpty: false })).toBe('keep-local');
  });
});

describe('decideOutbound', () => {
  const seen = (updatedAt: string | null) => ({ known: true as const, updatedAt });
  const unreadable = { known: false as const };

  it('writes when there is genuinely no cloud row yet', () => {
    expect(decideOutbound({ cloudClock: seen(null), lastSeenUpdatedAt: null })).toBe('write');
    expect(decideOutbound({ cloudClock: seen(null), lastSeenUpdatedAt: T1 })).toBe('write');
  });

  it('writes when the cloud row matches what this device last saw', () => {
    expect(decideOutbound({ cloudClock: seen(T1), lastSeenUpdatedAt: T1 })).toBe('write');
  });

  it('writes when this device has seen a newer row than the cloud reports', () => {
    expect(decideOutbound({ cloudClock: seen(T1), lastSeenUpdatedAt: T2 })).toBe('write');
  });

  it('defers when the cloud row is newer than what this device last saw', () => {
    expect(decideOutbound({ cloudClock: seen(T2), lastSeenUpdatedAt: T1 })).toBe('defer');
  });

  it('defers when the row exists but this device has no baseline', () => {
    expect(decideOutbound({ cloudClock: seen(T1), lastSeenUpdatedAt: null })).toBe('defer');
  });

  // THE DATA-LOSS CASE. A failed clock read used to be indistinguishable from
  // "no row exists", and both produced 'write' — so a device holding partial
  // local state could blind-upsert over a populated cloud row on nothing more
  // than a network blip. An unknown clock must NEVER authorise a write.
  it('NEVER writes on an unreadable clock, whatever the baseline', () => {
    for (const lastSeenUpdatedAt of [null, T1, T2, undefined]) {
      expect(decideOutbound({ cloudClock: unreadable, lastSeenUpdatedAt })).toBe('defer');
    }
  });

  it('distinguishes "no row" from "could not read" — they are not the same answer', () => {
    expect(decideOutbound({ cloudClock: seen(null), lastSeenUpdatedAt: null })).toBe('write');
    expect(decideOutbound({ cloudClock: unreadable, lastSeenUpdatedAt: null })).toBe('defer');
  });

  // Enumerates the whole input space and asserts the exact set of write-
  // authorising inputs. The earlier version asserted INSIDE an `if (write)`,
  // so an implementation that never wrote would have passed it vacuously.
  it('write is authorised by exactly these inputs and no others', () => {
    const clocks: Array<[string, ReturnType<typeof seen> | typeof unreadable]> = [
      ['no-row', seen(null)],
      ['T1', seen(T1)],
      ['T2', seen(T2)],
      ['unreadable', unreadable],
    ];
    const baselines: Array<[string, string | null]> = [['none', null], ['T1', T1], ['T2', T2]];

    const writes: string[] = [];
    for (const [cn, cloudClock] of clocks)
      for (const [bn, lastSeenUpdatedAt] of baselines)
        if (decideOutbound({ cloudClock, lastSeenUpdatedAt }) === 'write') writes.push(`${cn}/${bn}`);

    expect(writes.sort()).toEqual(
      [
        'no-row/none', 'no-row/T1', 'no-row/T2',  // virgin row: always safe
        'T1/T1',                                   // clock matches baseline
        'T1/T2',                                   // we have seen newer than cloud
        'T2/T2',
      ].sort()
    );
    // and the vacuity guard: writing must actually be reachable
    expect(writes.length).toBeGreaterThan(0);
  });
});

describe('last-seen cloud timestamp storage', () => {
  it('round-trips per user and stays isolated between users', async () => {
    expect(await getLastSeenCloudUpdatedAt('u1')).toBeNull();
    await setLastSeenCloudUpdatedAt('u1', T1);
    await setLastSeenCloudUpdatedAt('u2', T2);
    expect(await getLastSeenCloudUpdatedAt('u1')).toBe(T1);
    expect(await getLastSeenCloudUpdatedAt('u2')).toBe(T2);
  });
});

// connector-actions branches on `deferred`, NOT `status`, to decide whether a
// queued mutation reached the cloud. A result that said 'stale' while leaving
// deferred:false would make the drain receipt a mutation that never landed —
// other devices would then skip re-applying it, and the change is silently
// lost. All three plan reviewers flagged this independently; it is the whole
// reason `deferred` is derived rather than passed.
describe('outboundResult', () => {
  it('every non-written status defers — no status can leak through as written', () => {
    for (const status of ['stale', 'unknown'] as const) {
      expect(outboundResult(status, null).deferred).toBe(true);
      expect(outboundResult(status, T1).deferred).toBe(true);
    }
  });

  it('only a real write reports not-deferred', () => {
    expect(outboundResult('written', T1)).toEqual({
      status: 'written',
      deferred: false,
      cloudUpdatedAt: T1,
    });
  });

  it('carries the clock through untouched', () => {
    expect(outboundResult('stale', T2).cloudUpdatedAt).toBe(T2);
    expect(outboundResult('unknown', null).cloudUpdatedAt).toBeNull();
  });
});

// If the token does not change on a successful write, the CAS stops
// serialising: a competing device that read the same value still matches it
// and ALSO succeeds, so both writes land and the second silently overwrites
// the first. The guard would be doing nothing at all.
describe('nextWriteToken', () => {
  const BASE = '2026-08-28T12:00:00.500+00:00';       // as PostgREST returns it
  const ms = (iso: string) => Date.parse(iso);

  it('uses the clock when it has genuinely advanced', () => {
    const now = '2026-08-28T12:00:01.000Z';
    expect(nextWriteToken(now, BASE)).toBe(now);
  });

  it('advances past a base the clock has NOT beaten (same millisecond)', () => {
    const now = new Date(ms(BASE)).toISOString();      // identical instant
    const token = nextWriteToken(now, BASE);
    expect(ms(token)).toBeGreaterThan(ms(BASE));
  });

  it('advances past a base the clock is BEHIND (backwards skew)', () => {
    const now = '2026-08-28T11:59:59.000Z';
    const token = nextWriteToken(now, BASE);
    expect(ms(token)).toBeGreaterThan(ms(BASE));
  });

  // The invariant, independent of the branches: a write token is ALWAYS
  // strictly newer than what it swaps against.
  it('is ALWAYS strictly greater than the base, for any clock', () => {
    for (const now of [
      '2026-08-28T11:00:00.000Z',
      '2026-08-28T12:00:00.500Z',
      '2026-08-28T12:00:00.499Z',
      '2026-08-28T13:00:00.000Z',
      'not-a-date',
    ]) {
      expect(ms(nextWriteToken(now, BASE))).toBeGreaterThan(ms(BASE));
    }
  });

  it('passes the clock through when there is no base (insert path)', () => {
    const now = '2026-08-28T12:00:00.000Z';
    expect(nextWriteToken(now, null)).toBe(now);
  });

  it('does not choke on an unparseable base', () => {
    const now = '2026-08-28T12:00:00.000Z';
    expect(nextWriteToken(now, 'garbage')).toBe(now);
  });
});
