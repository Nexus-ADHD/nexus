/**
 * ListSection — grouped-row container (docs/plans/generic-list-row.md, PR 1).
 *
 * ONE kit Card padding="none" per group (one BlurView per group, not per row
 * — render budget, council Claude #13) wrapping the rows, with hairline
 * dividers BETWEEN rows inset to the text column (never full-bleed, none
 * after the last row). Rows own their padding so pressed backgrounds reach
 * the card edge (open question 2, resolved by council).
 *
 * Optional `title` renders the kit SectionHeader above the card — opt-in per
 * screen: its marginTop re-flows existing groups (council Claude #14).
 *
 * Usage:
 *   <ListSection title="Notifications">
 *     <ListRow title="Morning Reminder" trailing="value" value="7:00 AM" onPress={…} />
 *     <ListRow title="Milestone Alerts" trailing="toggle" trailingAccessory={<Toggle … />} />
 *   </ListSection>
 */

import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import tokens from '@/src/theme/tokens';
import { Card } from './Card';
import { SectionHeader } from './SectionHeader';
import {
  dividerInsetLeft,
  DIVIDER_HEIGHT,
  flattenFragmentChildren,
  rowLeftIcon,
} from './list-row-metrics';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ListSectionProps = {
  /** ListRow elements (custom row content is tolerated — treated as plain rows). */
  children: React.ReactNode;
  /** Opt-in kit SectionHeader above the card. */
  title?: string;
  style?: ViewStyle;
  testID?: string;
};

// ─── Component ────────────────────────────────────────────────────────────────

export function ListSection({ children, title, style, testID }: ListSectionProps) {
  // Flatten fragments FIRST (metrics module, vitest-covered): two rows inside
  // one fragment must get a divider between them, and a nested row's leftIcon
  // must reach the inset calculation — React.Children.toArray would preserve
  // the fragment as one opaque entry (Greptile PR #389 P2).
  const rows = flattenFragmentChildren(children) as React.ReactElement[];

  // A divider never runs under an icon gutter: it insets to the DEEPER of the
  // two adjacent rows' text columns (a leftIcon row insets past its gutter).
  function insetBetween(above: React.ReactElement, below: React.ReactElement): number {
    return Math.max(
      dividerInsetLeft(rowLeftIcon(above) != null),
      dividerInsetLeft(rowLeftIcon(below) != null),
    );
  }

  return (
    <View style={style} testID={testID}>
      {title != null && <SectionHeader>{title}</SectionHeader>}
      <Card padding="none">
        {rows.map((row, i) => (
          <React.Fragment key={row.key ?? i}>
            {row}
            {i < rows.length - 1 && (
              <View
                style={[styles.divider, { marginLeft: insetBetween(row, rows[i + 1]) }]}
                pointerEvents="none"
              />
            )}
          </React.Fragment>
        ))}
      </Card>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // 0.5pt hairline in the existing token (matches settings today), inset to
  // the text column via marginLeft; right edge runs to the card edge.
  divider: {
    height:          DIVIDER_HEIGHT,
    backgroundColor: tokens.color.goldHairline,
  },
});
