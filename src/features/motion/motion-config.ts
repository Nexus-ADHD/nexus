/**
 * Motion Config — Nexus Cosmic Pipeline
 * ────────────────────────────────────────────────────────────────────
 * Single source of truth for the contract between .riv files and the app.
 *
 * If you rename a state machine or input in Rive, you change it here too.
 * Mismatches fail loudly in dev via the <CosmicRing> asset-status banner.
 */

import tokens from '@/src/theme/tokens';

// v3 stellar: `amber` key renamed to `quiet` and remapped to textMuted.
// Amber retires from default utility (galaxy backdrop already carries warm
// combustion regions). The motion-config palette feeds paletteColorFor
// fallback color choice when Rive is unavailable — the low-tier fallback
// should read as "quiet" (cool blue-gray), not as "warning" (warm orange).
export const NEXUS_PALETTE = {
  obsidian: tokens.color.void,
  cream: tokens.color.text,
  gold: tokens.color.gold,
  quiet: tokens.color.textMuted,
  teal: tokens.color.teal,
} as const;

/**
 * Home accretion ring contract.
 *
 * The .riv file MUST expose a state machine named `CosmicRing` with:
 *   - number  input `score`      — range 0..100
 *   - trigger input `pulse`      — fires on habit-check haptic (optional)
 *   - text    run   `qualWord`   — bound to "Drifting" | "Steady" | "Rising"
 */
export const HOME_RING_CONFIG = {
  assetName: 'nexus-cosmic-ring.riv',
  stateMachine: 'CosmicRing',
  inputs: {
    score: 'score',
    pulse: 'pulse',
  },
  textRuns: {
    qualWord: 'qualWord',
  },
  /** Threshold bins for the qualitative word swap. */
  qualThresholds: {
    drifting: 33, // score < 33
    steady: 66,   // 33 <= score < 66
    // rising: score >= 66
  },
} as const;

/**
 * Command cosmic eye contract.
 *
 * The .riv file MUST expose a state machine named `CosmicEye` with:
 *   - number input `audioLevel` — range 0..1 (driven by expo-av metering)
 *   - trigger input `startListening`
 *   - trigger input `stopListening`
 *   - trigger input `startSpeaking`
 *   - trigger input `stopSpeaking`
 */
export const COMMAND_EYE_CONFIG = {
  assetName: 'nexus-cosmic-eye.riv',
  stateMachine: 'CosmicEye',
  inputs: {
    audioLevel: 'audioLevel',
    startListening: 'startListening',
    stopListening: 'stopListening',
    startSpeaking: 'startSpeaking',
    stopSpeaking: 'stopSpeaking',
  },
} as const;

/**
 * HEVC-alpha loop contract (Phase 5).
 *
 * Loops are placed in `src/features/motion/assets/`.
 * Encoding target: HEVC `hvc1`, alpha_quality 0.9, ≤ 1.5MB per loop.
 */
export const HEVC_CONFIG = {
  commandNebula: 'nexus-command-nebula.mov',
  homeStarfield: 'nexus-home-starfield.mov', // optional, Phase 3+
  maxBytes: 1_500_000,
} as const;

/**
 * Map a 0–100 score to its qualitative word.
 * Mirrors the thresholds in the .riv file exactly — if you change one, change both.
 */
export function qualitativeWordFor(score: number): 'Drifting' | 'Steady' | 'Rising' {
  if (score < HOME_RING_CONFIG.qualThresholds.drifting) return 'Drifting';
  if (score < HOME_RING_CONFIG.qualThresholds.steady) return 'Steady';
  return 'Rising';
}

/**
 * Map a 0–100 score to a palette hex color.
 * Used by fallback components when Rive is unavailable.
 */
export function paletteColorFor(score: number): string {
  if (score >= 80) return NEXUS_PALETTE.teal;
  if (score >= 50) return NEXUS_PALETTE.gold;
  if (score >= 25) return NEXUS_PALETTE.quiet;
  return NEXUS_PALETTE.cream;
}
