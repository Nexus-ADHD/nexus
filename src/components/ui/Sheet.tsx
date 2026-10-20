/**
 * Sheet — the canonical transparent-overlay primitive (§10.11, §10.12)
 *
 * Replaces the hand-rolled `<Modal transparent>` shell. Before this there were
 * 18 of them across 19 files in two shapes, with five different scrim values,
 * four different keyboard strategies, and two incompatible fixes for the same
 * backdrop-touch bug. This is that shell, once.
 *
 * SCOPE: transparent overlays only — bottom sheets and centred dialogs. The 10
 * modals using `presentationStyle="formSheet"` or `"fullScreen"` are NOT this
 * component's job: the OS draws those surfaces, there is no scrim to own, and a
 * fullScreen modal has to mount its own StarField because it renders above the
 * global one. Wrapping those would mean pretending to control something we do
 * not.
 *
 * Layer cake (bottom → top, inside the rounded sheet):
 *  1. BlurView absoluteFill (dropped under Reduce Transparency)
 *  2. Tint overlay (surfaceElevated, or near-opaque under Reduce Transparency)
 *  3. Inset highlight glow (top edge, luminous white)
 *  4. Handle (bottom variant only)
 *  5. Content
 *
 * ACCESSIBILITY, fixed by construction rather than left to each caller:
 *  - `accessibilityViewIsModal` traps VoiceOver inside the sheet. 27 of the 28
 *    hand-rolled modals let VoiceOver swipe out to the screen behind.
 *  - The scrim is hidden from VoiceOver. Under the focus trap it is unreachable
 *    anyway, and an unlabelled full-screen touch target is worse than nothing.
 *    **Your content must therefore carry its own close affordance** — the
 *    backdrop tap is a pointer convenience, not the accessible path.
 *  - `onRequestClose` is always wired, so the Android back button works. 11 of
 *    the 28 silently ignored it.
 *  - Keyboard avoidance is on by default. Two shipped dialogs contain a
 *    TextInput with no keyboard handling at all.
 *
 * Usage:
 *   <Sheet visible={open} onDismiss={close} accessibilityLabel="Edit habit">
 *     <Text>…</Text>
 *   </Sheet>
 *
 *   // Centred dialog that must not be dismissed by tapping away
 *   <Sheet
 *     variant="center"
 *     onDismiss={deny}
 *     dismissOnBackdropPress={false}
 *     accessibilityLabel="Usage data consent"
 *   >
 */

import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { useReduceTransparency } from '@/hooks/use-reduce-transparency';
import { ambientGlow } from '@/src/theme/glow';
import tokens from '@/src/theme/tokens';
import { haptic } from '@/src/utils/haptics';

import {
  animationTypeFor,
  handleShown,
  overlayJustify,
  overlayPaddingHorizontal,
  sheetCorners,
  sheetSurface,
  type SheetAnimation,
  type SheetVariant,
} from './sheet-metrics';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SheetProps = {
  children: React.ReactNode;
  /** Names the sheet for VoiceOver. Required — an unlabelled modal is a dead end. */
  accessibilityLabel: string;
  /** Called for a backdrop tap and for the Android back button. */
  onDismiss: () => void;
  /**
   * Defaults to `true` so a conditionally-mounted sheet — `{open && <Sheet …>}`,
   * which 9 of the 28 call sites rely on for unmount cleanup — works without
   * threading a redundant flag.
   */
  visible?: boolean;
  variant?: SheetVariant;
  /**
   * `'none'` when the caller drives its own entrance, as the level-up
   * celebration does. Reduce Motion is handled separately and always.
   */
  animation?: SheetAnimation;
  /** `false` for a decision the user must actually make, like a consent dialog. */
  dismissOnBackdropPress?: boolean;
  /**
   * Escape hatch for Android back / iOS lifecycle when it must NOT simply
   * close: the triage flow guards against iOS firing this during presentation,
   * and the cancel-offer guards on an in-flight request. Defaults to onDismiss.
   */
  onRequestClose?: () => void;
  /** Off only when the content manages the keyboard itself, e.g. via a ScrollView. */
  keyboardAvoiding?: boolean;
  showHandle?: boolean;
  /** Style for the sheet surface, not the overlay. */
  style?: ViewStyle;
  testID?: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

// §10.11: BlurView intensity 35 on the elevated surface. Card.tsx uses 55 for
// its own elevated variant, which is drift from the same spec line; this
// primitive follows the spec rather than the drift.
const BLUR_INTENSITY = 35;

// §10.11 handle: 36×4. The spec's 2pt radius is expressed as `full` — on a 4pt
// bar the two are visually identical, and `full` is on the radii scale.
const HANDLE_WIDTH = 36;
const HANDLE_HEIGHT = 4;

// A centred dialog should not span a tablet. Matches the shipped consent card.
const CENTER_MAX_WIDTH = 360;

// ─── Component ────────────────────────────────────────────────────────────────

export function Sheet({
  children,
  accessibilityLabel,
  onDismiss,
  visible = true,
  variant = 'bottom',
  animation = 'default',
  dismissOnBackdropPress = true,
  onRequestClose,
  keyboardAvoiding = true,
  showHandle,
  style,
  testID,
}: SheetProps) {
  const { reduceMotion } = useReduceMotion();
  const { reduceTransparency, resolved } = useReduceTransparency();
  // Treat "not yet resolved" as reduce-transparency so an RT user never sees a
  // one-frame blur flash before the async read lands. Same rule as Card.
  const opaque = !resolved || reduceTransparency;
  const { tint, blur } = sheetSurface(opaque, tokens.color);

  // §8.1: present is a soft impact, dismiss is silent — silence respects exit.
  useEffect(() => {
    if (visible) void haptic('modalPresent');
  }, [visible]);

  const animationType = animationTypeFor(variant, animation, reduceMotion);
  const corners = sheetCorners(variant, tokens.radii.sheet, tokens.radii.lg);
  const isBottom = variant === 'bottom';

  const surface = (
    <View
      accessibilityViewIsModal
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.sheet,
        corners,
        isBottom ? styles.sheetBottom : styles.sheetCenter,
        style,
      ]}
      testID={testID}
    >
      {/* Layer 1 — native blur of the cosmos behind. Removed under Reduce
          Transparency; the near-opaque tint below stands in. */}
      {blur && (
        <BlurView
          intensity={BLUR_INTENSITY}
          tint="dark"
          style={[StyleSheet.absoluteFill, corners]}
          pointerEvents="none"
        />
      )}

      {/* Layer 2 — translucent dark tint: the reading sanctuary. */}
      <View
        style={[StyleSheet.absoluteFill, corners, { backgroundColor: tint }]}
        pointerEvents="none"
      />

      {/* Layer 3 — inset highlight along the top edge. */}
      <LinearGradient
        colors={['rgba(255,255,255,0.04)', 'rgba(255,255,255,0)']}
        locations={[0, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.insetGlow}
        pointerEvents="none"
      />

      {/* Layer 4 — drag handle. Decoration: the gesture is the backdrop tap. */}
      {handleShown(variant, showHandle) && (
        <View style={styles.handleRow} pointerEvents="none">
          <View style={styles.handle} />
        </View>
      )}

      {/* Layer 5 — content. */}
      {children}
    </View>
  );

  const overlay = (
    <View
      style={[
        styles.overlay,
        {
          justifyContent: overlayJustify(variant),
          paddingHorizontal: overlayPaddingHorizontal(variant, tokens.spacing.lg),
        },
      ]}
    >
      {/* The dismiss target is a SIBLING of the sheet, not a parent.
          A Pressable wrapping everything makes inner taps bubble (tapping a
          grid cell dismissed the sheet) and loses the pan-gesture race against
          an inner ScrollView. Two call sites found this independently and fixed
          it two incompatible ways; this is the one that works.
          Hidden from VoiceOver — see the accessibility note in the header. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={dismissOnBackdropPress ? onDismiss : undefined}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      {isBottom ? (
        <SafeAreaView edges={['bottom']} style={styles.bottomInset}>
          {surface}
        </SafeAreaView>
      ) : (
        surface
      )}
    </View>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType={animationType}
      statusBarTranslucent
      onRequestClose={onRequestClose ?? onDismiss}
    >
      {keyboardAvoiding ? (
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          {overlay}
        </KeyboardAvoidingView>
      ) : (
        overlay
      )}
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  fill: { flex: 1 },

  overlay: {
    flex: 1,
    backgroundColor: tokens.color.scrim,
  },

  // SafeAreaView cannot carry the sheet's own background, or the inset strip
  // below it paints too — it wraps, it does not style.
  bottomInset: {
    backgroundColor: 'transparent',
  },

  sheet: {
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    overflow: 'hidden',
    ...ambientGlow,
  },

  sheetBottom: {
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.lg,
    maxHeight: '88%',
  },

  sheetCenter: {
    alignSelf: 'center',
    // width is 100% of the ALREADY-PADDED overlay — see
    // overlayPaddingHorizontal for why the inset cannot live here as a margin.
    width: '100%',
    maxWidth: CENTER_MAX_WIDTH,
    padding: tokens.spacing.lg,
  },

  insetGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: tokens.spacing.xxl,
    pointerEvents: 'none',
  },

  handleRow: {
    alignItems: 'center',
    paddingVertical: tokens.spacing.xs,
  },

  handle: {
    width: HANDLE_WIDTH,
    height: HANDLE_HEIGHT,
    borderRadius: tokens.radii.full,
    backgroundColor: tokens.color.sheetHandle,
  },
});
