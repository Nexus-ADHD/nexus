/**
 * CosmicRing — the public entry point for the Home hero.
 * ────────────────────────────────────────────────────────────────────
 * Drop-in usage in home-screen.tsx:
 *
 *   import { CosmicRing } from '../motion/CosmicRing';
 *   ...
 *   <CosmicRing score={todayScore} />
 *
 * Behavior:
 *   - Feature flag OFF (default) → renders nothing (null). Your existing
 *     score UI is untouched.
 *   - Feature flag ON → renders the Rive hero, or a graceful placeholder
 *     if the package or .riv asset isn't available yet.
 *
 * The flag is flipped from Settings → Debug → "Motion Pipeline" and
 * "Home Ring". This keeps the cinematic work invisible to users until
 * you're ready to ship it behind a TestFlight rollout.
 */
import React from 'react';
import { View } from 'react-native';
import { useHomeRingActive, useMotionFlags } from '../../state/motion-flags';
import { RiveCosmicRing } from './RiveCosmicRing';

export interface CosmicRingProps {
  /** Current daily execution score 0–100. */
  score: number;
  /** Diameter in logical px. Defaults to 280. */
  size?: number;
}

export function CosmicRing({ score, size = 280 }: CosmicRingProps) {
  const active = useHomeRingActive();
  const debug = useMotionFlags((s) => s.motionDebugOverlay);

  if (!active) return null;

  return (
    <View style={{ alignItems: 'center', marginVertical: 16 }}>
      <RiveCosmicRing score={score} size={size} debug={debug} />
    </View>
  );
}
