// NEX-260 (L-5) — pure, RN-free core for the solo structured-start flow.
// Kept out of RN modules so the phase machine + time formatting carry vitest
// coverage (the RN UI itself is device-verified — LEARNINGS).
//
// Direction (ticket + nex-215 plan doc PR3): presence, not performance. State an
// intention (voice OR text), see it reflected back, OPTIONALLY hold a solo focus
// timer (default off), end with a quiet acknowledgement. No streak, no score, no
// persisted metric, no social surface (§1.5 Laws B/C/E). Fully ephemeral.

export type StructuredStartPhase =
  | 'stating' // naming what you're about to do (voice or text)
  | 'reflecting' // the intention shown back as a steady line
  | 'timer_offer' // the opt-in focus-timer chips (nothing pre-selected)
  | 'running' // a focus timer is counting down
  | 'paused' // the focus timer is held
  | 'done'; // a timer session ended — the quiet close ("Done. You were here.")

export interface StructuredStartState {
  phase: StructuredStartPhase;
  /** The user-authored intention. Ephemeral — never persisted or logged. */
  intention: string;
  /** Chosen timer length in ms; null until a duration chip is picked. */
  durationMs: number | null;
  /** Current remaining ms while a timer is running/paused; null otherwise.
   *  The COMPONENT owns wall-clock (`endAtMs`) and feeds remaining in via tick —
   *  the reducer only clamps + auto-finishes, so it stays trivially pure. */
  remainingMs: number | null;
}

export type StructuredStartAction =
  | { type: 'set_intention'; text: string }
  | { type: 'reflect' } // stating → reflecting (guard: non-blank intention)
  | { type: 'offer_timer' } // reflecting → timer_offer
  | { type: 'start_timer'; durationMs: number } // timer_offer → running
  | { type: 'tick'; remainingMs: number } // running → running (clamp); ≤0 → done
  | { type: 'pause' } // running → paused
  | { type: 'resume' } // paused → running
  | { type: 'finish' } // running|paused → done ("I'm done")
  | { type: 'reset' };

// Calm, self-chosen focus lengths. No default selection — the user must pick, so
// there is never a default-on countdown (the ticket's core constraint).
export const DURATION_PRESETS_MS: number[] = [10, 25, 50].map((m) => m * 60_000);

export function initialStructuredStartState(): StructuredStartState {
  return { phase: 'stating', intention: '', durationMs: null, remainingMs: null };
}

export function reduceStructuredStart(
  state: StructuredStartState,
  action: StructuredStartAction,
): StructuredStartState {
  switch (action.type) {
    case 'set_intention':
      // Only editable while still naming it.
      if (state.phase !== 'stating') return state;
      if (action.text === state.intention) return state;
      return { ...state, intention: action.text };

    case 'reflect':
      // Guard a blank/whitespace intention — there is nothing to reflect.
      if (state.phase !== 'stating') return state;
      if (state.intention.trim().length === 0) return state;
      return { ...state, phase: 'reflecting' };

    case 'offer_timer':
      if (state.phase !== 'reflecting') return state;
      return { ...state, phase: 'timer_offer' };

    case 'start_timer':
      // Only from the offer; a non-positive duration is ignored.
      if (state.phase !== 'timer_offer') return state;
      if (!(action.durationMs > 0)) return state;
      return {
        ...state,
        phase: 'running',
        durationMs: action.durationMs,
        remainingMs: action.durationMs,
      };

    case 'tick': {
      // Only a running timer advances; reaching zero IS the close (no separate
      // ceremony — §1.5 Law C: acknowledge, never celebrate).
      if (state.phase !== 'running') return state;
      const rem = Math.max(0, action.remainingMs);
      if (rem <= 0) return { ...state, phase: 'done', remainingMs: 0 };
      return { ...state, remainingMs: rem };
    }

    case 'pause':
      if (state.phase !== 'running') return state;
      return { ...state, phase: 'paused' };

    case 'resume':
      if (state.phase !== 'paused') return state;
      return { ...state, phase: 'running' };

    case 'finish':
      // Early "I'm done" from either running or paused.
      if (state.phase !== 'running' && state.phase !== 'paused') return state;
      return { ...state, phase: 'done' };

    case 'reset':
      return initialStructuredStartState();

    default:
      return state;
  }
}

/** Remaining time as `M:SS` (tabular). Never negative; null reads as 0:00. */
export function formatRemaining(ms: number | null): string {
  const totalSec = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
