/**
 * Pure card-surface selection, split out so vitest (node env) covers it —
 * Card.tsx imports react-native + Reanimated and can't load under the node
 * runner. Import-free on purpose (takes the palette as a param), so the test
 * never transitively pulls RN.
 */

export type CardVariant = 'default' | 'elevated';

export type SurfacePalette = {
  surface: string;
  surfaceElevated: string;
  surfaceOpaque: string;
  surfaceElevatedOpaque: string;
};

/**
 * The `[rest, pressed]` tint colors a card's press animation interpolates
 * between. Under Reduce Transparency the BlurView is removed, so BOTH endpoints
 * must be opaque — otherwise pressing a card animates it back to the translucent
 * value (a silent visual regression that only appears under Reduce Transparency
 * + a pressable card). Mirrors the legacy mapping when transparency is allowed:
 * default rest→pressed = surface→surfaceElevated; elevated rest = pressed =
 * surfaceElevated.
 */
export function cardSurface(
  variant: CardVariant,
  reduceTransparency: boolean,
  p: SurfacePalette,
): { rest: string; pressed: string } {
  if (reduceTransparency) {
    return {
      rest: variant === 'elevated' ? p.surfaceElevatedOpaque : p.surfaceOpaque,
      pressed: p.surfaceElevatedOpaque,
    };
  }
  return {
    rest: variant === 'elevated' ? p.surfaceElevated : p.surface,
    pressed: p.surfaceElevated,
  };
}
