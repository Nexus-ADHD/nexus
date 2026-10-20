import React from 'react';
import { Text, Pressable, StyleSheet } from 'react-native';
import tokens from '../../theme/tokens';
import { haptic } from '../../utils/haptics';
import { PrimaryPill } from '../../components/ui/PrimaryPill';
import { Sheet } from '../../components/ui/Sheet';
import { useAppState } from '../../state/app-state';

const BG = tokens.color.void;
const BORDER = tokens.color.goldHairline;
const GOLD = tokens.color.gold;
const TEXT = tokens.color.text;
const MUTED = tokens.color.textMuted;

/**
 * NEX-136 P3 — first-run analytics consent.
 *
 * Self-gates: shows once, only after onboarding (isActivated) and only while
 * consent is still 'unset'. Choosing either option records the decision, which
 * flips `visible` to false and mirrors onto PostHog (see app/_layout.tsx).
 * Existing users migrate to 'unset', so they also see this once.
 *
 * Presentation is the Sheet primitive in its centred variant. The backdrop is
 * deliberately NOT dismissible: this is a decision the user has to make, and
 * tapping away would record neither answer. Copy is final (run through
 * nexus-voice-pass). No em dashes, no exclamation points, declarative endings.
 */
export default function AnalyticsConsentSheet() {
  const isActivated = useAppState((s) => s.isActivated);
  const analyticsConsent = useAppState((s) => s.analyticsConsent);
  const setAnalyticsConsent = useAppState((s) => s.setAnalyticsConsent);

  const visible = isActivated && analyticsConsent === 'unset';

  const grant = () => {
    setAnalyticsConsent('granted');
  };
  const deny = () => {
    haptic('buttonSecondary');
    setAnalyticsConsent('denied');
  };

  return (
    <Sheet
      visible={visible}
      variant="center"
      onDismiss={deny}
      dismissOnBackdropPress={false}
      accessibilityLabel="Usage data consent"
    >
      <Text style={styles.eyebrow}>USAGE DATA</Text>
      <Text style={styles.body}>
        Nexus can record how you use the app. Screens you open, features you touch, tied to your
        account. Never sold. Never shared with advertisers. Your habits, mandates, and reflections
        are never sent for analytics.
      </Text>

      <PrimaryPill fullWidth onPress={grant} style={{ marginBottom: tokens.spacing.xs }}>
        Allow usage data
      </PrimaryPill>

      <Pressable style={styles.secondary} onPress={deny}>
        <Text style={styles.secondaryText}>Not now</Text>
      </Pressable>

      <Text style={styles.footnote}>Change this anytime in Settings.</Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  eyebrow: { ...tokens.type.labelTrackedLg, color: GOLD, marginBottom: tokens.spacing.sm },
  body: { ...tokens.type.bodyMd, color: MUTED, marginBottom: tokens.spacing.md },
  secondary: {
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: tokens.radii.md,
    paddingVertical: tokens.spacing.sm,
    alignItems: 'center',
  },
  secondaryText: { ...tokens.type.buttonPrimary, color: MUTED },
  footnote: {
    ...tokens.type.caption,
    color: MUTED,
    textAlign: 'center',
    marginTop: tokens.spacing.sm,
  },
});
