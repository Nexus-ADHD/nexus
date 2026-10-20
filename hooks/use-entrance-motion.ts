import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { ornamentMayAnimate } from '@/src/utils/reduce-motion-policy';

/**
 * The `from` value for a card entrance, with its slide removed under Reduce
 * Motion.
 *
 * Why the fade survives and only the slide goes: a cross-fade is what Apple
 * recommends as the REPLACEMENT for a slide, not another thing to suppress.
 * Reduce Motion is about movement across the screen, which is what triggers
 * vestibular discomfort. Opacity carries no motion vector, so the card still
 * announces itself as new without travelling.
 *
 * Gated on `ornamentMayAnimate`, not `resolved`. The slide is decoration — the
 * content arrives either way — so it must fail toward stillness through every
 * unconfirmed window: first render, the in-flight preference read, and a read
 * that FAILED. §1.5 UF-01, and the LEARNINGS 2026-07-24 rule that a decorative
 * visual defaults to its absence until the preference is actually learned.
 *
 * Exists so the rule lives in one place. It was previously absent from every
 * Moti entrance in the app, and nine of them drifted from the claim in
 * `docs/accessibility/device-verification-checklist.md` that card entrances
 * were already opacity-only.
 *
 * Usage:
 *   const entranceFrom = useEntranceFrom(8);
 *   <MotiView from={entranceFrom} animate={{ opacity: 1, translateY: 0 }} />
 */
export function useEntranceFrom(translateY: number): { opacity: number; translateY: number } {
  const state = useReduceMotion();
  return { opacity: 0, translateY: ornamentMayAnimate(state) ? translateY : 0 };
}
