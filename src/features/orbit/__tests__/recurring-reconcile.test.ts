import { describe, expect, it } from 'vitest';
import {
  decideRecurringReconcile,
  resolveLink,
  type LinkState,
  type LookupOutcome,
} from '../recurring-reconcile';

describe('resolveLink', () => {
  it('trusts the device-local link when present', () => {
    expect(resolveLink({ appleEventId: 'mirror' }, 'local-1')).toEqual({
      linkState: 'mine',
      eventId: 'local-1',
    });
  });

  // THE BUG THIS SHAPE EXISTS TO PREVENT. A rule arriving from another device
  // carries that device's EventKit id in the synced mirror. This device has no
  // local link for it, so the id is at most ADOPTABLE — never authoritative,
  // and never grounds for concluding the event was deleted.
  it('treats a mirror with no local link as adoptable only', () => {
    expect(resolveLink({ appleEventId: 'from-other-device' }, null)).toEqual({
      linkState: 'legacy-unowned',
      eventId: 'from-other-device',
    });
  });

  it('reports none when there is nothing to test', () => {
    expect(resolveLink({}, null).linkState).toBe('none');
    expect(resolveLink({ appleEventId: null }, null).linkState).toBe('none');
    expect(resolveLink(undefined, null).linkState).toBe('none');
  });

  // An unhydrated store returns null. That must read as "no link", i.e. do
  // nothing — never as "my event is gone".
  it('degrades to adoptable-or-none before the store has hydrated', () => {
    expect(resolveLink({ appleEventId: 'x' }, null).linkState).toBe('legacy-unowned');
    expect(resolveLink({}, null).linkState).toBe('none');
  });
});

describe('decideRecurringReconcile', () => {
  it('never touches anything without calendar permission', () => {
    for (const linkState of ['mine', 'legacy-unowned', 'none'] as LinkState[])
      for (const lookupOutcome of ['found', 'missing', 'error'] as LookupOutcome[])
        expect(
          decideRecurringReconcile({ hasCalendarPermission: false, linkState, lookupOutcome })
        ).toBe('skip');
  });

  it('updates when this device own link resolves', () => {
    expect(
      decideRecurringReconcile({
        hasCalendarPermission: true,
        linkState: 'mine',
        lookupOutcome: 'found',
      })
    ).toBe('update');
  });

  it('unlinks — never deletes — when our own event is gone', () => {
    expect(
      decideRecurringReconcile({
        hasCalendarPermission: true,
        linkState: 'mine',
        lookupOutcome: 'missing',
      })
    ).toBe('unlink');
  });

  it('adopts an unowned link only on proof it resolves here', () => {
    expect(
      decideRecurringReconcile({
        hasCalendarPermission: true,
        linkState: 'legacy-unowned',
        lookupOutcome: 'found',
      })
    ).toBe('adopt');
  });

  // The original data-loss path: another device's id does not resolve here.
  // Leave it completely alone — not deleted, and not cleared either.
  it('leaves an unresolvable unowned link untouched', () => {
    expect(
      decideRecurringReconcile({
        hasCalendarPermission: true,
        linkState: 'legacy-unowned',
        lookupOutcome: 'missing',
      })
    ).toBe('skip');
  });

  it('never acts on a thrown lookup', () => {
    for (const linkState of ['mine', 'legacy-unowned', 'none'] as LinkState[])
      expect(
        decideRecurringReconcile({
          hasCalendarPermission: true,
          linkState,
          lookupOutcome: 'error',
        })
      ).toBe('skip');
  });

  // THE LOAD-BEARING TEST (owner-approved, 2026-08-27).
  //
  // Six review rounds each found a different route to "the event is gone, so
  // delete the routine". Rather than patch a seventh, the auto-delete was
  // removed: no input may produce a destructive action. If someone reinstates
  // one, this fails.
  it('NO input can produce a destructive action', () => {
    const actions = new Set<string>();
    for (const hasCalendarPermission of [true, false])
      for (const linkState of ['mine', 'legacy-unowned', 'none'] as LinkState[])
        for (const lookupOutcome of ['found', 'missing', 'error'] as LookupOutcome[])
          actions.add(
            decideRecurringReconcile({ hasCalendarPermission, linkState, lookupOutcome })
          );

    // Every reachable action is additive or a no-op. 'delete' is not in the
    // type any more, and must never come back.
    expect([...actions].sort()).toEqual(['adopt', 'skip', 'unlink', 'update']);
    expect([...actions]).not.toContain('delete');
  });

  // End-to-end shape check: the exact iPad scenario that lost data.
  it('a second device receiving a cloud rule never harms it', () => {
    const cloudRule = { appleEventId: 'iphone-event-id' };
    const { linkState } = resolveLink(cloudRule, null); // no local link on the iPad
    expect(linkState).toBe('legacy-unowned');
    expect(
      decideRecurringReconcile({
        hasCalendarPermission: true,
        linkState,
        lookupOutcome: 'missing', // the iPhone's id resolves to nothing here
      })
    ).toBe('skip');
  });
});
