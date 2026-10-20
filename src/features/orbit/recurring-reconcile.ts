/**
 * Pure decision for the Orbit ↔ Apple Calendar recurring-rule reconcile,
 * split out so vitest (node env) covers it — orbit.tsx is @ts-nocheck and
 * imports react-native.
 *
 * WHY THIS EXISTS — a cross-device data-loss bug (2026-08-27).
 *
 * `recurringRules` syncs through the cloud, and each rule could carry an
 * `appleEventId`: an EventKit `eventIdentifier`, which is **local to the
 * device that created it**. The same calendar event has a different
 * identifier on every device.
 *
 * The reconcile read a missing event as "the user deleted this in Apple
 * Calendar" and called deleteRecurringRule. On a SECOND device every
 * cloud-arrived rule carried a foreign identifier, so the lookup always
 * missed and the rules were deleted — then the deletion synced back and took
 * them off the original device too. It also ran with no permission check, so
 * declining the calendar prompt deleted as well (the lookup threw; the catch
 * deleted).
 *
 * THE ROOT CAUSE IS THE SHAPE, NOT THE BRANCH: one device-local identifier
 * living in shared, synced state. A first fix that unlinked instead of
 * deleting still had the second device clear the field and relink with its
 * own id — quietly stealing the association, so the originating device could
 * no longer detect a real deletion of its own event.
 *
 * So the link is now PER DEVICE: `appleEventLinks[deviceId] = eventId`. Every
 * device reads and writes only its own slot and never touches another's. A
 * device with no slot has no opinion about this rule and does nothing; the
 * title+time matcher fills its slot on a later pass.
 *
 * Legacy rules carry a bare `appleEventId` with no known owner. A device may
 * ADOPT one — but only by proving it: if the lookup resolves, the identifier
 * was minted here, so claim it into this device's slot. If it does not
 * resolve, it belongs to some other device; leave it completely alone.
 *
 * NO BRANCH HERE DELETES A ROUTINE (owner-approved, 2026-08-27).
 *
 * Six review rounds on this file each found a different path to the same
 * outcome: some ordering, ownership or race subtlety made the app conclude
 * "the event is gone" and delete the user's routine. The auto-delete was a
 * convenience — deleting the event in Apple Calendar removed the routine too —
 * and it was the ONLY reason any of this could destroy data.
 *
 * So it is gone. A missing event now unlinks and nothing else. The routine
 * survives; the user deletes routines in the app. This does not patch the six
 * defects individually, it makes their entire class unreachable: with no
 * delete branch, no future race or ownership mistake in this area can cost a
 * user their data. Reconciliation is now purely additive — it links, updates
 * schedule/time, and unlinks. Nothing destructive.
 */

export type ReconcileAction =
  /** This device's link resolved. Sync schedule/time back onto the rule. */
  | 'update'
  /** An unowned mirror resolved here — claim it as this device's link. */
  | 'adopt'
  /** Our event is gone. Drop the dead link; KEEP the routine. */
  | 'unlink'
  /** Touch nothing. */
  | 'skip';

export type LookupOutcome =
  /** getEventAsync returned an event. */
  | 'found'
  /** getEventAsync resolved empty — no such event in THIS device's store. */
  | 'missing'
  /** getEventAsync threw. Could be permissions, could be transient. */
  | 'error';

export type LinkState =
  /** This device has its own slot for this rule. */
  | 'mine'
  /** A pre-per-device `appleEventId` with no recorded owner. */
  | 'legacy-unowned'
  /** Nothing to reconcile here — the matcher will link it later. */
  | 'none';

export type ReconcileInput = {
  /** Whether calendar permission is actually granted right now. */
  hasCalendarPermission: boolean;
  linkState: LinkState;
  lookupOutcome: LookupOutcome;
};

export function decideRecurringReconcile(input: ReconcileInput): ReconcileAction {
  // No permission means every lookup is meaningless — a miss says nothing
  // about whether the event exists. Never mutate rules on this basis.
  if (!input.hasCalendarPermission) return 'skip';

  // Nothing linked for this device. Not ours to reason about.
  if (input.linkState === 'none') return 'skip';

  // A thrown lookup is not evidence of anything. Far more likely a revoked
  // permission, an unloaded store, or a transient EventKit failure.
  if (input.lookupOutcome === 'error') return 'skip';

  if (input.linkState === 'mine') {
    // Our own identifier. A miss means the backing event is gone — but that is
    // grounds for dropping the LINK, never the routine. See the header note.
    return input.lookupOutcome === 'found' ? 'update' : 'unlink';
  }

  // legacy-unowned: adopt only on proof. A miss means it was minted on some
  // other device, so leave the field untouched for that device to claim.
  return input.lookupOutcome === 'found' ? 'adopt' : 'skip';
}

/**
 * Resolve which identifier THIS device should test for a rule, and what that
 * link means. `localEventId` comes from the device-local store
 * (src/state/apple-link-store.ts) — never from the synced rule.
 */
export function resolveLink(
  rule: { appleEventId?: string | null } | undefined | null,
  localEventId: string | null | undefined
): { linkState: LinkState; eventId: string | null } {
  if (localEventId) return { linkState: 'mine', eventId: localEventId };

  // A rule can carry an appleEventId this device has never claimed: a legacy
  // rule from before the store existed, or another device's mirror arriving
  // through the cloud. Either way it is only ADOPTABLE — testable, and claimed
  // if it resolves. It is never grounds for a delete.
  if (rule?.appleEventId) {
    return { linkState: 'legacy-unowned', eventId: rule.appleEventId };
  }

  return { linkState: 'none', eventId: null };
}
