import { describe, expect, it } from 'vitest';
import {
  selectCutOrCommitItems,
  CUT_OR_COMMIT_MIN_AGE_MS,
  CUT_OR_COMMIT_CAP,
} from '../cut-or-commit';

// NEX-201 (H-7/I-3): the few oldest inbox items awaiting a decision, oldest-
// first, capped. Calm + scarce — aging conveyed by ORDER, never a day-counter.

const NOW = 1_700_000_000_000;
const daysAgo = (d: number) => NOW - d * 24 * 60 * 60 * 1000;

const item = (over: Record<string, unknown> = {}) => ({
  id: 'x',
  title: 'Thing',
  status: 'ACTIVE',
  completed: false,
  createdAt: daysAgo(20),
  ...over,
});

describe('selectCutOrCommitItems (NEX-201)', () => {
  it('returns only items older than 14 days, awaiting a decision', () => {
    const inbox = [
      item({ id: 'old', createdAt: daysAgo(20) }),
      item({ id: 'fresh', createdAt: daysAgo(3) }),
    ];
    const out = selectCutOrCommitItems(inbox, NOW);
    expect(out.map((t) => t.id)).toEqual(['old']);
  });

  it('excludes ARCHIVED and completed items', () => {
    const inbox = [
      item({ id: 'archived', status: 'ARCHIVED' }),
      item({ id: 'done', completed: true }),
      item({ id: 'live' }),
    ];
    expect(selectCutOrCommitItems(inbox, NOW).map((t) => t.id)).toEqual(['live']);
  });

  it('excludes triaged-skip items (intentionally absent from the active inbox)', () => {
    const inbox = [
      item({ id: 'skipped', triagedSkip: true }),
      item({ id: 'live' }),
    ];
    expect(selectCutOrCommitItems(inbox, NOW).map((t) => t.id)).toEqual(['live']);
  });

  it('excludes items with missing or non-finite createdAt', () => {
    const inbox = [
      item({ id: 'no-date', createdAt: undefined }),
      item({ id: 'nan-date', createdAt: NaN }),
      item({ id: 'ok' }),
    ];
    expect(selectCutOrCommitItems(inbox, NOW).map((t) => t.id)).toEqual(['ok']);
  });

  it('uses a strict threshold: exactly 14 days does not surface, 14d + 1ms does', () => {
    const exactly14 = item({ id: 'edge', createdAt: NOW - CUT_OR_COMMIT_MIN_AGE_MS });
    const justOver = item({ id: 'over', createdAt: NOW - CUT_OR_COMMIT_MIN_AGE_MS - 1 });
    expect(selectCutOrCommitItems([exactly14], NOW)).toEqual([]);
    expect(selectCutOrCommitItems([justOver], NOW).map((t) => t.id)).toEqual(['over']);
  });

  it('sorts oldest-first', () => {
    const inbox = [
      item({ id: 'mid', createdAt: daysAgo(20) }),
      item({ id: 'oldest', createdAt: daysAgo(40) }),
      item({ id: 'newest-eligible', createdAt: daysAgo(15) }),
    ];
    expect(selectCutOrCommitItems(inbox, NOW).map((t) => t.id)).toEqual([
      'oldest',
      'mid',
      'newest-eligible',
    ]);
  });

  it('caps at the display cap, keeping the oldest', () => {
    const inbox = [40, 30, 25, 20, 16].map((d, i) =>
      item({ id: `i${i}-${d}d`, createdAt: daysAgo(d) }),
    );
    const out = selectCutOrCommitItems(inbox, NOW);
    expect(out).toHaveLength(CUT_OR_COMMIT_CAP);
    expect(out.map((t) => t.id)).toEqual(['i0-40d', 'i1-30d', 'i2-25d']);
  });

  it('is deterministic on equal createdAt: preserves original inbox order', () => {
    const ts = daysAgo(20);
    const inbox = [
      item({ id: 'a', createdAt: ts }),
      item({ id: 'b', createdAt: ts }),
      item({ id: 'c', createdAt: ts }),
    ];
    expect(selectCutOrCommitItems(inbox, NOW).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array or its order', () => {
    const inbox = [
      item({ id: 'mid', createdAt: daysAgo(20) }),
      item({ id: 'oldest', createdAt: daysAgo(40) }),
    ];
    const snapshot = inbox.map((t) => t.id);
    selectCutOrCommitItems(inbox, NOW);
    expect(inbox.map((t) => t.id)).toEqual(snapshot);
  });

  it('returns [] for empty and non-array inputs', () => {
    expect(selectCutOrCommitItems([], NOW)).toEqual([]);
    expect(selectCutOrCommitItems(null, NOW)).toEqual([]);
    expect(selectCutOrCommitItems(undefined, NOW)).toEqual([]);
  });
});
