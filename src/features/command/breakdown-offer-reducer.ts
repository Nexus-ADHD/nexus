/**
 * breakdown-offer-reducer.ts — NEX-210 (C-5)
 *
 * Pure per-item state machine behind the confirmation ledger's "break this into
 * steps" offer. Mirrors the async-accept structure of time-block-offer-reducer
 * (NEX-206): a grain chip is tapped, an AI call runs in flight, and the resolve
 * lands later with stale-phase guards. Modeled as a pure reducer (no RN) so
 * vitest covers every transition — including the resolve-after-the-phase-moved
 * race — without a renderer.
 *
 * Phases:
 *   offered    → grain chips shown; user can tap a grain
 *   generating → a grain was tapped; AI breakdown in flight (chips locked)
 *   generated  → steps landed in Inbox; "N steps in your Inbox" + undo shown
 *   reverted   → undone; the created steps removed (offer row collapses)
 *
 * Landing is done in the parent after the AI resolves (like time-block's accept).
 * The parent guards a resolve that lands after unmount (it must NOT create rows
 * silently — see the ledger's suspend-dismiss-while-generating + mountedRef);
 * this reducer additionally drops a stale resolve via the phase guard.
 */
import type { BreakdownGrain } from './breakdown';

export type BreakdownPhase = 'offered' | 'generating' | 'generated' | 'reverted';

export interface BreakdownOfferState {
  phase: BreakdownPhase;
  /** The grain being generated / generated at. Null until a chip is tapped. */
  grain: BreakdownGrain | null;
  /** The generated step titles (for the result count). Empty until generated. */
  steps: string[];
  /** Inbox ids created for the steps — what `undo` deletes. Empty until generated. */
  stepIds: string[];
  /** True after a generate failed — drives a transparent, no-blame retry note. */
  error?: boolean;
}

export type BreakdownOfferAction =
  | { type: 'generate'; grain: BreakdownGrain }
  | { type: 'generate_resolved'; steps: string[]; stepIds: string[] }
  | { type: 'generate_failed' }
  | { type: 'undo' };

export function initialBreakdownOfferState(): BreakdownOfferState {
  return { phase: 'offered', grain: null, steps: [], stepIds: [] };
}

export function reduceBreakdownOffer(
  state: BreakdownOfferState,
  action: BreakdownOfferAction,
): BreakdownOfferState {
  switch (action.type) {
    case 'generate':
      // Guard double-tap / tap-while-in-flight: only an `offered` row can start.
      // Clears any prior error (fresh attempt).
      if (state.phase !== 'offered') return state;
      return { ...state, phase: 'generating', grain: action.grain, error: false };

    case 'generate_resolved': {
      // A resolve that lands after the phase moved on (or with no steps) is stale
      // / empty — ignore so a late success can't create an orphaned result row.
      if (state.phase !== 'generating') return state;
      if (action.steps.length === 0) {
        return { ...state, phase: 'offered', error: true };
      }
      return {
        ...state,
        phase: 'generated',
        steps: action.steps,
        stepIds: action.stepIds,
        error: false,
      };
    }

    case 'generate_failed':
      if (state.phase !== 'generating') return state;
      // Nothing landed: back to the offer so the user can retry, flag no-blame error.
      return { ...state, phase: 'offered', grain: null, error: true };

    case 'undo':
      // Only a landed (generated) breakdown can be reverted.
      if (state.phase !== 'generated') return state;
      return { ...state, phase: 'reverted', error: false };

    default:
      return state;
  }
}
