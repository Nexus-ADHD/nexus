// Haptic feedback helper — NEX-56
// All haptics in the app route through this helper. Never call `Haptics.*Async`
// directly — use `haptic('keyName')` so the vocabulary stays centralized in
// `tokens.hapticMap` (see CLAUDE.md §8.1).
//
// To add a new haptic moment:
//   1. Add a key to `tokens.hapticMap` in src/theme/tokens.ts
//   2. Call `haptic('newKey')` at the site
//
// If a haptic key has no entry in TYPE_MAP, this is a no-op (silent fail) — the
// app should never crash because a haptic is missing.

import * as Haptics from 'expo-haptics';
import tokens from '@/src/theme/tokens';

type HapticType = typeof tokens.haptic[keyof typeof tokens.haptic];

const TYPE_MAP: Record<HapticType, () => Promise<void>> = {
  selection:           () => Haptics.selectionAsync(),
  impactLight:         () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  impactMedium:        () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  impactHeavy:         () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy),
  impactSoft:          () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft),
  notificationSuccess: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  notificationWarning: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
};

/**
 * Fire a haptic for a named interaction.
 * @param key — one of the keys in `tokens.hapticMap` (e.g. 'habitResolve', 'voiceStart')
 */
export function haptic(key: keyof typeof tokens.hapticMap): Promise<void> {
  const type = tokens.hapticMap[key] as HapticType | undefined;
  const fn = type ? TYPE_MAP[type] : undefined;
  if (!fn) return Promise.resolve();
  return fn().catch(() => {
    // Swallow — haptics are best-effort. Never let a missing engine crash UI.
  });
}
