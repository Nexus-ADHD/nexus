/**
 * Pure StarField motion decisions, split out so vitest (node env) can cover
 * the reduce-motion freeze/resume logic — StarField.tsx itself imports
 * react-native + Reanimated and cannot load under the node test runner.
 */

/**
 * The frozen frame the twinkle clock holds at under Reduce Motion (CLAUDE.md
 * §6.6). The per-star opacity in `TwinkleDot` is a pure function of `time`, so
 * a single static value lands the field at varied, non-trough opacities (a
 * still but pleasing sky). 3500ms is a starting point — device-tune if it
 * lands trough-heavy.
 */
export const FROZEN_TIME_MS = 3500;

/**
 * Whether the ~60fps twinkle ticker should run. Only once the reduce-motion
 * preference has resolved AND is off. Before resolution (or when reduce motion
 * is on) the field holds frozen at FROZEN_TIME_MS, so a reduce-motion user
 * never sees a first-frame twinkle.
 */
export function tickerActive(reduceMotion: boolean, resolved: boolean): boolean {
  return resolved && !reduceMotion;
}
