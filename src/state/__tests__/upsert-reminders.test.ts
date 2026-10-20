import { describe, it, expect } from 'vitest';
import {
  upsertRemindersIntoInbox,
  findRecentUnstampedLocalMatch,
  VOICE_MIRROR_DEDUP_WINDOW_MS,
} from '../upsert-reminders';

type Item = {
  id: string;
  title: string;
  completed: boolean;
  status?: string;
  createdAt?: number;
  source?: string;
  externalId?: string;
  dueDate?: string;
  [k: string]: any;
};

const NOW = 1_700_000_000_000; // arbitrary fixed instant
let nextLocalId = 0;
const nextId = () => `local-${++nextLocalId}`;

describe('findRecentUnstampedLocalMatch', () => {
  it('matches an unstamped apple_reminders item with same title within the window', () => {
    const inbox: Item[] = [
      {
        id: 'l1',
        title: 'Call mom',
        completed: false,
        status: 'NEW',
        source: 'apple_reminders',
        createdAt: NOW - 2_000, // 2s ago, within 10s window
      },
    ];
    const idx = findRecentUnstampedLocalMatch(
      inbox,
      { id: 'EXT-1', listId: 'nexus', title: 'Call mom' },
      NOW,
    );
    expect(idx).toBe(0);
  });

  it('does not match when title differs', () => {
    const inbox: Item[] = [
      {
        id: 'l1',
        title: 'Call mom',
        completed: false,
        source: 'apple_reminders',
        createdAt: NOW - 1_000,
      },
    ];
    const idx = findRecentUnstampedLocalMatch(
      inbox,
      { id: 'EXT-1', listId: 'nexus', title: 'Different thing' },
      NOW,
    );
    expect(idx).toBe(-1);
  });

  it('does not match when local item is older than the dedup window', () => {
    const inbox: Item[] = [
      {
        id: 'l1',
        title: 'Call mom',
        completed: false,
        source: 'apple_reminders',
        createdAt: NOW - VOICE_MIRROR_DEDUP_WINDOW_MS - 1,
      },
    ];
    const idx = findRecentUnstampedLocalMatch(
      inbox,
      { id: 'EXT-1', listId: 'nexus', title: 'Call mom' },
      NOW,
    );
    expect(idx).toBe(-1);
  });

  it('does not match when externalId is already stamped', () => {
    const inbox: Item[] = [
      {
        id: 'l1',
        title: 'Call mom',
        completed: false,
        source: 'apple_reminders',
        externalId: 'EXT-already',
        createdAt: NOW - 1_000,
      },
    ];
    const idx = findRecentUnstampedLocalMatch(
      inbox,
      { id: 'EXT-1', listId: 'nexus', title: 'Call mom' },
      NOW,
    );
    expect(idx).toBe(-1);
  });

  it('does not match a manual item with the same title', () => {
    const inbox: Item[] = [
      {
        id: 'l1',
        title: 'Call mom',
        completed: false,
        source: 'manual',
        createdAt: NOW - 1_000,
      },
    ];
    const idx = findRecentUnstampedLocalMatch(
      inbox,
      { id: 'EXT-1', listId: 'nexus', title: 'Call mom' },
      NOW,
    );
    expect(idx).toBe(-1);
  });

  it('matches with normalized title (case + whitespace)', () => {
    const inbox: Item[] = [
      {
        id: 'l1',
        title: '  Call Mom  ',
        completed: false,
        source: 'apple_reminders',
        createdAt: NOW - 1_000,
      },
    ];
    const idx = findRecentUnstampedLocalMatch(
      inbox,
      { id: 'EXT-1', listId: 'nexus', title: 'CALL MOM' },
      NOW,
    );
    expect(idx).toBe(0);
  });
});

describe('upsertRemindersIntoInbox', () => {
  it('prepends new items as apple_reminders source with externalId stamped', () => {
    const result = upsertRemindersIntoInbox<Item>(
      [],
      [{ id: 'EXT-1', listId: 'nexus', title: 'Yoga' }],
      nextId,
      NOW,
    );
    expect(result.added).toBe(1);
    expect(result.inbox).toHaveLength(1);
    expect(result.inbox[0].externalId).toBe('EXT-1');
    expect(result.inbox[0].source).toBe('apple_reminders');
  });

  it('updates title in place when fetched record drifts', () => {
    const inbox: Item[] = [
      {
        id: 'l1',
        title: 'Old title',
        completed: false,
        status: 'NEW',
        source: 'apple_reminders',
        externalId: 'EXT-1',
      },
    ];
    const result = upsertRemindersIntoInbox<Item>(
      inbox,
      [{ id: 'EXT-1', listId: 'nexus', title: 'New title' }],
      nextId,
      NOW,
    );
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.inbox[0].title).toBe('New title');
  });

  it('skips an archived item rather than resurrecting it', () => {
    const inbox: Item[] = [
      {
        id: 'l1',
        title: 'Old',
        completed: false,
        status: 'ARCHIVED',
        source: 'apple_reminders',
        externalId: 'EXT-1',
      },
    ];
    const result = upsertRemindersIntoInbox<Item>(
      inbox,
      [{ id: 'EXT-1', listId: 'nexus', title: 'Old' }],
      nextId,
      NOW,
    );
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.inbox[0].status).toBe('ARCHIVED');
  });

  it('Phase 4 race window: stamps externalId on a recent unstamped local rather than duplicating', () => {
    const inbox: Item[] = [
      {
        id: 'l1',
        title: 'Call mom',
        completed: false,
        status: 'NEW',
        source: 'apple_reminders',
        // No externalId yet — voice mirror in flight.
        createdAt: NOW - 500, // 500ms ago, well within window
      },
    ];
    const result = upsertRemindersIntoInbox<Item>(
      inbox,
      [{ id: 'EXT-NEW', listId: 'nexus', title: 'Call mom' }],
      nextId,
      NOW,
    );
    expect(result.added).toBe(0); // no duplicate
    expect(result.updated).toBe(1);
    expect(result.inbox).toHaveLength(1);
    expect(result.inbox[0].id).toBe('l1'); // same local item
    expect(result.inbox[0].externalId).toBe('EXT-NEW');
  });

  it('outside the race window: creates a duplicate (race window expired)', () => {
    const inbox: Item[] = [
      {
        id: 'l1',
        title: 'Call mom',
        completed: false,
        status: 'NEW',
        source: 'apple_reminders',
        createdAt: NOW - VOICE_MIRROR_DEDUP_WINDOW_MS - 1,
      },
    ];
    const result = upsertRemindersIntoInbox<Item>(
      inbox,
      [{ id: 'EXT-NEW', listId: 'nexus', title: 'Call mom' }],
      nextId,
      NOW,
    );
    expect(result.added).toBe(1);
    expect(result.inbox).toHaveLength(2);
  });
});
