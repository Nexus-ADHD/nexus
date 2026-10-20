import { describe, expect, it } from 'vitest';
import { prependInboxTaskIdempotently } from '../prepend-inbox-task';

describe('prependInboxTaskIdempotently', () => {
  it('reuses the existing Inbox id for the same proposal key', () => {
    const existing = [{ id: 'existing', proposalKey: 'plaud:source:item', title: 'First' }];
    const result = prependInboxTaskIdempotently(existing, {
      id: 'new',
      proposalKey: 'plaud:source:item',
      title: 'Duplicate',
    });

    expect(result).toEqual({ inbox: existing, id: 'existing', created: false });
  });

  it('continues to prepend ordinary Inbox tasks', () => {
    const existing = [{ id: 'existing', title: 'First' }];
    const candidate = { id: 'new', title: 'Second' };
    const result = prependInboxTaskIdempotently(existing, candidate);

    expect(result).toEqual({ inbox: [candidate, ...existing], id: 'new', created: true });
  });
});
