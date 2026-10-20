/**
 * Pure pill-size resolution, split out so vitest (node env) covers it —
 * PrimaryPill.tsx imports react-native + Reanimated and can't load under the
 * node runner. Import-free on purpose (no tokens import), mirroring
 * card-surface.ts: values are the design-spec numbers (§10.4 + the v2 button
 * exploration docs), duplicated here with comments.
 *
 * Consumed by PrimaryPill (and any future pill-family button) so default /
 * compact / fullWidth geometry resolves identically everywhere.
 */

export type PillSize = 'default' | 'compact';

export type PillMetrics = {
  height: number;
  paddingHorizontal: number;
  /**
   * minWidth is the 200pt hero floor from §10.4. Dropped when fullWidth (the
   * pill stretches to its container, so a floor would only fight the layout)
   * and on compact (a 200pt floor contradicts "compact").
   */
  minWidth?: number;
  /**
   * fullWidth pills stretch the PAINTED body to the container — outer wrapper
   * alignSelf 'stretch' + inner body width '100%' — so the visual body equals
   * the touch target. (Dropping minWidth alone left the inner pill
   * shrink-wrapped while the outer Pressable stretched.)
   */
  fillWidth: boolean;
};

const HEIGHT_DEFAULT = 56;
const HEIGHT_COMPACT = 44;
const PAD_H_DEFAULT = 32; // tokens.spacing.xl
const PAD_H_COMPACT = 20; // between spacing.lg (24) and spacing.md (16)
const MIN_WIDTH_DEFAULT = 200;

export function resolvePillMetrics(size: PillSize, fullWidth: boolean): PillMetrics {
  if (size === 'compact') {
    return {
      height: HEIGHT_COMPACT,
      paddingHorizontal: PAD_H_COMPACT,
      minWidth: undefined,
      fillWidth: fullWidth,
    };
  }
  return {
    height: HEIGHT_DEFAULT,
    paddingHorizontal: PAD_H_DEFAULT,
    minWidth: fullWidth ? undefined : MIN_WIDTH_DEFAULT,
    fillWidth: fullWidth,
  };
}
