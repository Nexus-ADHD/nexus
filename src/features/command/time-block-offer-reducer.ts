/**
 * time-block-offer-reducer.ts — NEX-206 (Or-3)
 *
 * Pure per-item state machine behind the confirmation ledger's "offer a time"
 * affordance. A bare time-less habit that landed on Today is offered a suggested
 * wide block; one tap applies it (and syncs Apple Calendar in the parent), with
 * an independent undo that reverts to the prior block.
 *
 * Extracted as a pure reducer (no RN) so vitest covers every transition —
 * including the async-race guards (double-tap, undo-before-accepted, a resolve
 * landing after the phase moved on) — without a renderer. Per the NEX-220
 * lesson: model the whole machine here, not one branch at a time in the view.
 *
 * Phases:
 *   offered    → chips shown; user can tap a block
 *   accepting  → a block was tapped; calendar work in flight (chips locked)
 *   accepted   → block applied + synced; "Set to afternoons." + undo shown
 *   reverted   → undone; block cleared, event deleted (offer row collapses)
 *
 * Accept is ATOMIC with the calendar: on failure nothing is applied, so the
 * machine returns to `offered` (with `error` set for a transparent retry note).
 */
import type { TimeBlock } from '../../utils/recurrence';

export type OfferPhase = 'offered' | 'accepting' | 'accepted' | 'reverted';

export interface OfferState {
  phase: OfferPhase;
  /** The applied (or being-applied) block. Null until a block is accepted. */
  block: TimeBlock | null;
  /** What `undo` restores. Null for a bare time-less habit (its prior state). */
  priorBlock: TimeBlock | null;
  /** True after an accept failed atomically — drives a transparent retry note. */
  error?: boolean;
}

export type OfferAction =
  | { type: 'accept'; block: TimeBlock }
  | { type: 'accept_resolved' }
  | { type: 'accept_failed' }
  | { type: 'undo' };

/** A bare time-less habit starts `offered` with no prior block to revert to. */
export function initialOfferState(priorBlock: TimeBlock | null = null): OfferState {
  return { phase: 'offered', block: priorBlock, priorBlock };
}

export function reduceOffer(state: OfferState, action: OfferAction): OfferState {
  switch (action.type) {
    case 'accept':
      // Guard the double-tap / tap-while-in-flight race: only an `offered` row
      // can begin accepting. Clears any prior error (this is a fresh attempt).
      if (state.phase !== 'offered') return state;
      return { ...state, phase: 'accepting', block: action.block, error: false };

    case 'accept_resolved':
      // A resolve that lands after an undo/revert (or any non-accepting phase)
      // is stale — ignore it so a late success can't resurrect a reverted row.
      if (state.phase !== 'accepting') return state;
      return { ...state, phase: 'accepted', error: false };

    case 'accept_failed':
      if (state.phase !== 'accepting') return state;
      // Atomic accept: nothing was applied. Return to the offer so the user can
      // retry, and flag the error for a no-blame note (§1.5 Law C).
      return { ...state, phase: 'offered', block: state.priorBlock, error: true };

    case 'undo':
      // Only an applied (accepted) block can be reverted.
      if (state.phase !== 'accepted') return state;
      return { ...state, phase: 'reverted', block: state.priorBlock, error: false };

    default:
      return state;
  }
}
