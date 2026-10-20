import { useCallback } from 'react';
import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';

import { SettingsScreen } from '../../src/features/settings/settings-screen';
import tokens from '../../src/theme/tokens';

// `/settings` index route. Settings is normally presented modally from Home
// (formSheet); this route exists so deep links / router.push('/settings')
// (e.g. the Talk header gear) land somewhere real instead of Expo Router's
// unmatched-route screen. Chrome mirrors Home's modal: screen + ✕ overlay.
export default function SettingsIndexRoute() {
  const router = useRouter();

  // Every exit routes through here. A bare back() strands a COLD entry: this
  // route's whole reason to exist is deep links, and a deep link opens
  // /settings with NO history — so back() has nowhere to go and the user is
  // left on settings with a dead ✕. Fall back to the tab root, which is where
  // dismissing settings means to land anyway.
  const dismiss = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }, [router]);

  return (
    <>
      <SettingsScreen onSignOut={dismiss} onClose={dismiss} />
      <Pressable
        onPress={dismiss}
        hitSlop={8}
        style={{ position: 'absolute', top: 16, right: 16, padding: 8 }}
        accessibilityRole="button"
        accessibilityLabel="Close settings">
        <Text
          style={{ color: tokens.color.textMuted, fontSize: 18 }}
          accessibilityElementsHidden
          importantForAccessibility="no">
          ✕
        </Text>
      </Pressable>
    </>
  );
}
