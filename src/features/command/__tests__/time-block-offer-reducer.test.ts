import { describe, expect, it } from 'vitest';
import {
  initialOfferState,
  reduceOffer,
  type OfferState,
} from '../time-block-offer-reducer';

// NEX-206 (Or-3): the per-item offer state machine. Every transition + the
// async-race guards are covered here so the ledger view never re-derives them.

describe('reduceOffer (NEX-206)', () => {
  const offered = (): OfferState => initialOfferState(null);

  it('starts offered with no applied block and no prior block (bare habit)', () => {
    expect(offered()).toEqual({ phase: 'offered', block: null, priorBlock: null });
  });

  it('offered → accepting on a block tap, recording the chosen block', () => {
    const s = reduceOffer(offered(), { type: 'accept', block: 'afternoon' });
    expect(s.phase).toBe('accepting');
    expect(s.block).toBe('afternoon');
    expect(s.error).toBe(false);
  });

  it('accepting → accepted on resolve', () => {
    let s = reduceOffer(offered(), { type: 'accept', block: 'morning' });
    s = reduceOffer(s, { type: 'accept_resolved' });
    expect(s.phase).toBe('accepted');
    expect(s.block).toBe('morning');
  });

  it('accepting → offered (atomic) on failure, flagging error and applying nothing', () => {
    let s = reduceOffer(offered(), { type: 'accept', block: 'evening' });
    s = reduceOffer(s, { type: 'accept_failed' });
    expect(s.phase).toBe('offered');
    expect(s.block).toBeNull(); // priorBlock — nothing applied
    expect(s.error).toBe(true);
  });

  it('accepted → reverted on undo, restoring the prior block', () => {
    let s = reduceOffer(offered(), { type: 'accept', block: 'night' });
    s = reduceOffer(s, { type: 'accept_resolved' });
    s = reduceOffer(s, { type: 'undo' });
    expect(s.phase).toBe('reverted');
    expect(s.block).toBeNull();
  });

  // ─── async-race guards ───────────────────────────────────────────────

  it('ignores a second accept while already accepting (double-tap)', () => {
    const accepting = reduceOffer(offered(), { type: 'accept', block: 'morning' });
    const again = reduceOffer(accepting, { type: 'accept', block: 'night' });
    expect(again).toBe(accepting); // unchanged — first tap wins
  });

  it('ignores undo before a block is accepted', () => {
    const s = offered();
    expect(reduceOffer(s, { type: 'undo' })).toBe(s);
    const accepting = reduceOffer(s, { type: 'accept', block: 'morning' });
    expect(reduceOffer(accepting, { type: 'undo' })).toBe(accepting);
  });

  it('ignores a stale resolve that lands after undo (late success cannot resurrect)', () => {
    let s = reduceOffer(offered(), { type: 'accept', block: 'afternoon' });
    s = reduceOffer(s, { type: 'accept_resolved' });
    s = reduceOffer(s, { type: 'undo' }); // reverted
    const after = reduceOffer(s, { type: 'accept_resolved' });
    expect(after.phase).toBe('reverted');
  });

  it('clears a prior error when the user retries the accept', () => {
    let s = reduceOffer(offered(), { type: 'accept', block: 'morning' });
    s = reduceOffer(s, { type: 'accept_failed' }); // offered + error
    expect(s.error).toBe(true);
    s = reduceOffer(s, { type: 'accept', block: 'afternoon' });
    expect(s.phase).toBe('accepting');
    expect(s.error).toBe(false);
  });

  it('clears error on a later failed retry path round-trip without leaking state', () => {
    // offered → accepting → accepted is unreachable from an errored offered
    // unless re-accepted; a successful retry yields a clean accepted state.
    let s = reduceOffer(offered(), { type: 'accept', block: 'morning' });
    s = reduceOffer(s, { type: 'accept_failed' });
    s = reduceOffer(s, { type: 'accept', block: 'evening' });
    s = reduceOffer(s, { type: 'accept_resolved' });
    expect(s).toMatchObject({ phase: 'accepted', block: 'evening', error: false });
  });
});
