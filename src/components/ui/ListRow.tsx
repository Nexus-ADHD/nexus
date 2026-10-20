/**
 * ListRow — generic kit list row (docs/plans/generic-list-row.md, PR 1).
 *
 * One row component replaces every hand-rolled row/rowLabel/rowValue/
 * rowChevron StyleSheet block in the app. Geometry, trailing resolution,
 * a11y-label derivation and haptic suppression live in the import-free
 * sibling list-row-metrics.ts (vitest-covered, pill-metrics.ts pattern).
 *
 * Usage:
 *   <ListRow title="Phone Number" trailing="value" value="+1 555…" onPress={…} />
 *   <ListRow title="Milestone Alerts" trailing="toggle" trailingAccessory={<Toggle … />} />
 *   <ListRow title="Delete Account" destructive onPress={…} />
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { haptic } from '@/src/utils/haptics';
import tokens from '@/src/theme/tokens';
import {
  defaultTrailing,
  deriveA11yLabel,
  hasInteractiveAccessory,
  LEFT_ICON_GAP,
  LEFT_ICON_SIZE,
  resolveRowA11y,
  resolveTrailing,
  ROW_MIN_HEIGHT,
  ROW_PADDING_HORIZONTAL,
  type ListRowTrailing,
  TRAILING_MAX_WIDTH,
  trailingMaxWidth,
} from './list-row-metrics';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ListRowProps = {
  title: string;
  /** ≤2 lines, muted 13pt, Dynamic-Type-capped (PrimaryPill pattern). */
  subtitle?: string;
  /**
   * Gold caption BELOW the subtitle, on its own line. For a warning or
   * qualifier that must not be swallowed by the subtitle's 2-line cap
   * (calendar settings' "OAuth client id not configured.").
   */
  footnote?: string;
  /** Glyph in a left gutter, monochrome. Dividers inset past it (ListSection). */
  leftIcon?: React.ReactNode;
  /** Defaults to 'chevron' for an actionable row, 'none' otherwise. */
  trailing?: ListRowTrailing;
  /** Rendered only for trailing:'toggle' | 'custom' (kind wins — metrics). */
  trailingAccessory?: React.ReactNode;
  /**
   * Declares that `trailingAccessory` is something the user must REACH (a
   * switch, a button). The row then stops being a single accessibility element
   * so the control keeps its own focus, role and state. Defaults to true for
   * trailing:'toggle'; a 'custom' accessory must opt in — presence alone can't
   * tell a live button from a static status badge.
   */
  interactiveAccessory?: boolean;
  /** Let a control CLUSTER (e.g. two Steppers) exceed the 45% trailing cap. */
  trailingWide?: boolean;
  /** Shown only for value-bearing kinds ('value'/'value-chevron'). */
  value?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  /** Trailing shows … and accessibilityState.busy is set. */
  busy?: boolean;
  /** Trailing value text goes gold (≤2 gold elements/screen, §19). */
  selected?: boolean;
  /** Title tints stateError. */
  destructive?: boolean;
  /** Dims the row and blocks press. */
  disabled?: boolean;
  testID?: string;
  /**
   * Spoken form of a CUSTOM accessory — a status badge, a plan name — which the
   * kit renders as opaque children and so cannot read for itself. Prefer this
   * over `accessibilityLabel`: it feeds the derivation, so the subtitle and
   * footnote are still announced.
   */
  accessoryLabel?: string;
  /**
   * TOTAL override of the derived label. Supplying it means the caller owns the
   * whole announcement — title, state, subtitle AND footnote — because nothing
   * is appended to it. To name an accessory and keep the rest, use
   * `accessoryLabel`.
   */
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_MS = tokens.motion.quick.duration; // 140ms
const QUICK_EASING = Easing.bezier(0.4, 0, 0.2, 1);

// Pressed flash endpoints: transparent rest → surfaceElevated (spec block).
// Local rgba-zero rest (not a token) so interpolateColor stays rgba → rgba.
const FLASH_REST = 'rgba(0,0,0,0)';

// Dynamic Type: TEXT SCALES, ORNAMENT DOESN'T. The title, subtitle and
// footnote scale without a cap — the row is minHeight, not height, precisely
// so it can grow with the user's type size (§17; §1.5 UF-01 makes this
// gating). The trailing column is capped: it competes for horizontal space
// against the text column, and a chevron rendered at 3x is decorative noise,
// not information.
//
// Exported because it is a CONTRACT, not a private constant: a text-bearing
// `trailingAccessory` is rendered as-is, so its caller must apply this cap
// itself (#396 P2 — day cyclers and Pause Mode's "Resume" were growing without
// bound and stealing the title's space). Non-text controls (Switch) are
// unaffected — they don't scale with type size.
export const TRAILING_MAX_SCALE = 1.3;

// ─── Component ────────────────────────────────────────────────────────────────

export function ListRow({
  title,
  subtitle,
  footnote,
  leftIcon,
  trailing,
  trailingAccessory,
  interactiveAccessory,
  trailingWide,
  value,
  onPress,
  onLongPress,
  delayLongPress,
  busy = false,
  selected = false,
  destructive = false,
  disabled = false,
  testID,
  accessoryLabel,
  accessibilityLabel,
  accessibilityHint,
}: ListRowProps) {
  // hasAction drives button SEMANTICS (a disabled row is still a disabled
  // action — VoiceOver/TalkBack must announce it as such); isPressable only
  // gates interaction. Greptile PR #389 P1.
  const hasAction = onPress != null || onLongPress != null;
  const isPressable = hasAction && !disabled;

  // A chevron is a promise of navigation, so only an actionable row inherits
  // one by default (PR 0 / D2).
  const kind = trailing ?? defaultTrailing(hasAction);
  const resolved = resolveTrailing({ trailing: kind, trailingAccessory, value, selected });
  const a11y = resolveRowA11y({
    hasAction,
    trailing: kind,
    trailingAccessory,
    interactiveAccessory,
  });

  // ── Press flash (background only — rows don't scale) ──────────────────────
  const pressProgress = useSharedValue(0); // 0 = rest, 1 = pressed
  const flashAnimStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      pressProgress.value,
      [0, 1],
      [FLASH_REST, tokens.color.surfaceElevated],
    ),
  }));

  function handlePressIn() {
    if (!isPressable) return;
    pressProgress.value = withTiming(1, { duration: QUICK_MS, easing: QUICK_EASING });
    // ListRow OWNS the press haptic (screens strip theirs in PR 2) — EXCEPT
    // when an interactive trailingAccessory is present (single-haptic rule,
    // #388 regression: the Switch's own haptic is the only one that fires).
    // 'tabChange' is the existing selection-type key settings rows already
    // fire at call sites today — no new hapticMap key needed.
    if (!hasInteractiveAccessory(kind, trailingAccessory)) {
      haptic('tabChange');
    }
  }

  function handlePressOut() {
    if (!isPressable) return;
    pressProgress.value = withTiming(0, { duration: QUICK_MS, easing: QUICK_EASING });
  }

  // ── Accessibility ─────────────────────────────────────────────────────────
  // ONE composition rule for everything spoken by the row. The row is often a
  // single accessibility element, so any text inside it that is missing here is
  // never spoken at all — that includes the subtitle, which the layout also
  // clips at two lines, and a custom accessory, which the kit cannot read.
  // `accessibilityLabel` remains a TOTAL override for callers who want it
  // (#396: an explicit label used merely to name an accessory silently dropped
  // the subtitle — `accessoryLabel` is the right tool for that job).
  const a11yLabel =
    accessibilityLabel ??
    deriveA11yLabel({
      title,
      value,
      showValue: resolved.showValue,
      accessoryLabel,
      subtitle,
      footnote,
    });

  // ── Trailing content ──────────────────────────────────────────────────────
  let trailingContent: React.ReactNode = null;
  if (busy) {
    trailingContent = <Text style={styles.value} maxFontSizeMultiplier={TRAILING_MAX_SCALE}>…</Text>;
  } else if (resolved.showAccessory) {
    trailingContent = trailingAccessory;
  } else {
    trailingContent = (
      <>
        {resolved.showValue && (
          <Text
            style={[styles.value, selected && styles.valueSelected]}
            maxFontSizeMultiplier={TRAILING_MAX_SCALE}
          >
            {value}
          </Text>
        )}
        {resolved.showChevron && (
          <Text style={styles.chevron} maxFontSizeMultiplier={TRAILING_MAX_SCALE}>›</Text>
        )}
        {resolved.showExternal && (
          <Text style={styles.chevron} maxFontSizeMultiplier={TRAILING_MAX_SCALE}>↗</Text>
        )}
        {resolved.showCheck && (
          <Text style={styles.check} maxFontSizeMultiplier={TRAILING_MAX_SCALE}>✓</Text>
        )}
      </>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  // The row's INNARDS are identical in all three shapes; only the wrapper
  // differs (see resolveRowA11y).
  const rowBody = (
      <Animated.View
        style={[
          styles.row,
          isPressable && flashAnimStyle,
          disabled && styles.rowDisabled,
        ]}
      >
        {leftIcon && <View style={styles.iconGutter}>{leftIcon}</View>}

        <View style={styles.textColumn}>
          <Text
            style={[
              styles.title,
              destructive && styles.titleDestructive,
            ]}
          >
            {title}
          </Text>
          {/* Text scales freely — the row is minHeight, not height, precisely
              so it can grow with the user's type size. Only the ORNAMENT is
              capped (see TRAILING_MAX_SCALE). */}
          {subtitle && (
            <Text style={styles.subtitle} numberOfLines={2}>
              {subtitle}
            </Text>
          )}
          {footnote && <Text style={styles.footnote}>{footnote}</Text>}
        </View>

        {trailingContent != null && (
          <View style={[styles.trailing, { maxWidth: trailingMaxWidth(trailingWide) }]}>{trailingContent}</View>
        )}
      </Animated.View>
  );

  // Shape 1 — the ROW is the action.
  if (a11y.pressable) {
    return (
      <Pressable
        onPress={isPressable ? onPress : undefined}
        onLongPress={isPressable ? onLongPress : undefined}
        delayLongPress={delayLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        // Only ever passed on an actionable row: RN merges this over
        // accessibilityState (Pressable.js:228), so passing it on an
        // informational row announces that row as dimmed.
        disabled={a11y.passDisabled ? !isPressable : undefined}
        // False when the row also hosts a control (e.g. the hidden-long-press
        // quotes row): the switch has to stay reachable, and the title and
        // subtitle remain readable as their own text elements.
        accessible={a11y.accessible}
        accessibilityRole={a11y.role}
        accessibilityState={{ selected, busy, disabled }}
        accessibilityLabel={a11yLabel}
        accessibilityHint={accessibilityHint}
        testID={testID}
      >
        {rowBody}
      </Pressable>
    );
  }

  // Shapes 2 and 3 — no action, so no Pressable at all: a handler-less
  // Pressable still joins the responder chain and can intercept taps aimed at a
  // nested control. `accessible` then decides between the static informational
  // row (one element, label + value read together) and the control-hosting row
  // (children stay individually focusable).
  return (
    <View
      accessible={a11y.accessible}
      accessibilityRole={a11y.role}
      accessibilityState={a11y.accessible ? { selected, busy } : undefined}
      accessibilityLabel={a11y.accessible ? a11yLabel : undefined}
      accessibilityHint={a11y.accessible ? accessibilityHint : undefined}
      testID={testID}
    >
      {rowBody}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  row: {
    minHeight:          ROW_MIN_HEIGHT, // 56 — minHeight, NOT height (Dynamic Type)
    paddingHorizontal:  ROW_PADDING_HORIZONTAL, // 16
    paddingVertical:    tokens.spacing.sm, // 12 — minHeight does the sizing work
    flexDirection:      'row',
    alignItems:         'center',
  },

  rowDisabled: {
    opacity: 0.5, // matches today's settings busy/disabled dim
  },

  iconGutter: {
    width:          LEFT_ICON_SIZE,
    height:         LEFT_ICON_SIZE,
    alignItems:     'center',
    justifyContent: 'center',
    marginRight:    LEFT_ICON_GAP,
  },

  textColumn: {
    flex:           1,
    justifyContent: 'center',
  },

  // Inter Medium 15pt, straight off the type scale. The kit shipped a
  // hand-composed SemiBold triple justified as "today's rows" — but today's
  // rows were system-font REGULAR, so that quietly made 25 settings rows
  // shout at once. Medium holds up on translucent glass over the cosmic
  // backdrop without flattening hierarchy: white-vs-muted and the tracked
  // §10.2 headers do the structural work, not weight.
  title: {
    ...tokens.type.bodyMdEmphasis,
    color: tokens.color.text,
  },

  titleDestructive: {
    color: tokens.color.stateError,
  },

  subtitle: {
    ...tokens.type.caption, // Inter Medium 13pt
    color:     tokens.color.textMuted,
    marginTop: 2,
  },

  // Gold qualifier on its OWN line, below the subtitle's 2-line cap — a
  // warning folded into the subtitle gets truncated away (D4).
  footnote: {
    ...tokens.type.caption,
    color:     tokens.color.gold,
    marginTop: 2,
  },

  // Structural backstop for the cap above: even an accessory that ignores
  // TRAILING_MAX_SCALE can only shrink the text column so far, never crowd it
  // out. flexShrink lets the trailing give way first; the text is the content.
  trailing: {
    flexDirection: 'row',
    alignItems:    'center',
    marginLeft:    tokens.spacing.sm,
    flexShrink:    1,
    maxWidth:      TRAILING_MAX_WIDTH,
  },

  // Trailing value: body, muted; gold when the row is selected (§19 budget
  // is the screen's job — ≤2 gold elements/screen).
  value: {
    ...tokens.type.bodyMd,
    color: tokens.color.textMuted,
  },

  valueSelected: {
    color: tokens.color.gold,
  },

  chevron: {
    fontSize:   14,
    color:      tokens.color.chevron,
    marginLeft: tokens.spacing.xs,
  },

  // Selection-list checkmark — teal, never a radio (spec block).
  check: {
    fontSize:   14,
    fontWeight: '600',
    color:      tokens.color.teal,
    marginLeft: tokens.spacing.xs,
  },
});
