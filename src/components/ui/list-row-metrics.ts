/**
 * Pure list-row resolution, split out so vitest (node env) covers it —
 * ListRow.tsx imports react-native + Reanimated and can't load under the
 * node runner. Import-free on purpose (no tokens import), mirroring
 * pill-metrics.ts: values are the design-spec numbers
 * (docs/plans/generic-list-row.md, token-mapped spec block), duplicated
 * here with comments.
 *
 * Consumed by ListRow (geometry, trailing resolution, a11y label, haptic
 * suppression) and ListSection (divider insets) so every row in the app
 * resolves identically.
 */

export type ListRowTrailing =
  | 'none'
  | 'chevron'
  | 'value'
  | 'value-chevron'
  | 'external'
  | 'check'
  | 'toggle'
  | 'custom';

/**
 * The kind a row falls back to when the caller omits `trailing`: a chevron
 * promises navigation, so only an ACTIONABLE row may default to one. A row with
 * no action defaults to 'none' — an informational row must never wear an
 * affordance it does not have (the apple-reminders "No reminder lists found"
 * empty state shipped with a fake chevron on the closed union).
 */
export function defaultTrailing(hasAction: boolean): ListRowTrailing {
  return hasAction ? 'chevron' : 'none';
}

// ─── Geometry (spec block) ────────────────────────────────────────────────────

export const ROW_MIN_HEIGHT = 56;        // minHeight, NOT height — Dynamic Type
export const ROW_PADDING_HORIZONTAL = 16; // tokens.spacing.md
export const LEFT_ICON_SIZE = 20;        // tokens.icon.size.lg
export const LEFT_ICON_GAP = 12;         // tokens.spacing.sm
export const DIVIDER_HEIGHT = 0.5;       // tokens.material.hairline.width

/**
 * Dividers are inset to the TEXT column, never full-bleed: a plain row's
 * divider starts at the row padding; a row with leftIcon insets past the
 * icon gutter (padding + icon + gap) so the line never runs under the icon.
 */
/**
 * How much of the row a trailing accessory may take.
 *
 * The default 45% is a structural backstop, not a style choice: an accessory
 * that ignores TRAILING_MAX_SCALE can still only shrink the text column so far,
 * never crowd it out. The text is the content.
 *
 * A CONTROL CLUSTER is the one case that legitimately needs more. A time row
 * carries two Steppers plus a separator and a meridiem — about 168pt — which at
 * 45% of a 393pt screen (162pt of usable width) overflows, and worse on a 320pt
 * screen or at large text, where the controls collide with the label. 62% fits
 * the cluster with room to spare while still guaranteeing the label over a
 * third of the row, and the row grows in height rather than clipping because
 * §10.19 specifies minHeight, never a fixed height.
 *
 * Opt in explicitly (`trailingWide`) so the exception is visible at the call
 * site rather than the cap being quietly loosened for every row in the app.
 */
export const TRAILING_MAX_WIDTH = '45%' as const;
export const TRAILING_MAX_WIDTH_WIDE = '62%' as const;

export function trailingMaxWidth(
  wide?: boolean,
): typeof TRAILING_MAX_WIDTH | typeof TRAILING_MAX_WIDTH_WIDE {
  return wide ? TRAILING_MAX_WIDTH_WIDE : TRAILING_MAX_WIDTH;
}

export const DIVIDER_INSET_PLAIN = ROW_PADDING_HORIZONTAL;                                  // 16
export const DIVIDER_INSET_ICON = ROW_PADDING_HORIZONTAL + LEFT_ICON_SIZE + LEFT_ICON_GAP;  // 48

export function dividerInsetLeft(hasLeftIcon: boolean): number {
  return hasLeftIcon ? DIVIDER_INSET_ICON : DIVIDER_INSET_PLAIN;
}

// ─── Trailing resolution ─────────────────────────────────────────────────────

export type TrailingResolution = {
  kind: ListRowTrailing;
  /** Value text renders — value-bearing kinds ('value'/'value-chevron') only. */
  showValue: boolean;
  /** › glyph — 'chevron' and 'value-chevron'. */
  showChevron: boolean;
  /** ↗ glyph — 'external' (replaces the chevron for web-outs). */
  showExternal: boolean;
  /** Teal ✓ — 'check' AND the row is selected (an unselected option shows nothing). */
  showCheck: boolean;
  /** trailingAccessory renders — 'toggle'/'custom' kinds with an accessory present. */
  showAccessory: boolean;
};

/**
 * Precedence (council Claude #21/22): the trailing KIND wins over stray props.
 * A `trailingAccessory` passed with a non-accessory kind is ignored, and
 * `value` only ever renders/announces for value-bearing kinds — a value
 * passed with trailing:'chevron' is dropped, not smuggled in.
 */
export function resolveTrailing({
  trailing = 'chevron',
  trailingAccessory,
  value,
  selected = false,
}: {
  trailing?: ListRowTrailing;
  /** Presence-only — this import-free module can't type ReactNode. */
  trailingAccessory?: unknown;
  value?: string;
  /** Gates the ✓: a selection list draws the check on the CHOSEN option only. */
  selected?: boolean;
}): TrailingResolution {
  const accessoryKind = trailing === 'toggle' || trailing === 'custom';
  const valueBearing = trailing === 'value' || trailing === 'value-chevron';
  return {
    kind: trailing,
    showValue: valueBearing && value != null && value !== '',
    showChevron: trailing === 'chevron' || trailing === 'value-chevron',
    showExternal: trailing === 'external',
    // 'check' marks a CHOICE, so it follows `selected` — an always-on check
    // would put a ✓ on every option in a picker (PickerRow, form-controls.md).
    showCheck: trailing === 'check' && selected,
    showAccessory: accessoryKind && trailingAccessory != null,
  };
}

/**
 * Single-haptic rule (#388 regression): a row carrying an interactive
 * trailingAccessory (Switch etc.) suppresses the ROW press haptic — the
 * accessory's own control haptic is the only one that fires. Accessory is
 * only interactive when the kind actually renders it ('toggle'/'custom').
 */
export function hasInteractiveAccessory(
  trailing: ListRowTrailing,
  trailingAccessory?: unknown,
): boolean {
  return (trailing === 'toggle' || trailing === 'custom') && trailingAccessory != null;
}

// ─── Accessibility shape ─────────────────────────────────────────────────────

export type RowA11y = {
  /**
   * Render the row as a Pressable. False for a row with no action — a
   * handler-less Pressable still joins the touch responder chain and can
   * intercept taps meant for a nested control.
   */
  pressable: boolean;
  /**
   * The row is ONE accessibility element (its children are merged into it and
   * stop being individually focusable — iOS behavior for an accessible
   * container). Must be false whenever the row hosts a control the user has to
   * reach.
   */
  accessible: boolean;
  /**
   * Hand RN's Pressable a `disabled` prop. RN merges it over
   * accessibilityState (Pressable.js:228), so passing it on a row that is not
   * an action makes an informational row announce as "dimmed".
   */
  passDisabled: boolean;
  /** 'button' only when the ROW itself is the action. */
  role: 'button' | undefined;
};

/**
 * The three shapes a row can take, and what each owes the screen reader
 * (PR 0 — the #389/#391 regression: ListRow was ALWAYS a Pressable, so RN's
 * `accessible: accessible !== false` default made every row a container that
 * swallowed its own Switch, and the always-passed `disabled` announced every
 * informational row as dimmed).
 *
 *  1. Row IS the action        → one element, role=button, disabled honored.
 *  2. Static informational row → one element, no role, NOT disabled, so
 *                                "Version, 1.0.0" still reads as one thing.
 *  3. Row HOSTS a control      → not an element at all; the title, subtitle and
 *                                the control stay separately focusable and the
 *                                control keeps its own role and on/off state.
 *
 * Interactivity is DECLARED, never inferred from the accessory's presence:
 * `hasInteractiveAccessory` above is presence-only and reads a static status
 * badge (Subscription's plan text, Apple Calendar's NATIVE) as interactive,
 * which would strip case 2 from exactly the read-only rows that need it.
 * 'toggle' is interactive by definition; 'custom' must say so.
 */
export function resolveRowA11y({
  hasAction,
  trailing,
  trailingAccessory,
  interactiveAccessory,
}: {
  hasAction: boolean;
  trailing: ListRowTrailing;
  trailingAccessory?: unknown;
  /** Defaults to true for 'toggle' (a switch is always reachable-or-broken). */
  interactiveAccessory?: boolean;
}): RowA11y {
  const rendersAccessory =
    (trailing === 'toggle' || trailing === 'custom') && trailingAccessory != null;
  const hostsControl =
    rendersAccessory && (interactiveAccessory ?? trailing === 'toggle');

  return {
    pressable: hasAction,
    accessible: !hostsControl,
    passDisabled: hasAction,
    role: hasAction ? 'button' : undefined,
  };
}

// ─── Accessibility label ──────────────────────────────────────────────────────

/**
 * Auto-derived a11y label (PrimaryPill pattern).
 *
 * THE RULE: when the row is one accessibility element, its children stop being
 * individually focusable — so every piece of text rendered inside it that is
 * not in this label is simply never spoken. The label must therefore carry the
 * row's FULL text, including copy the layout truncates: `subtitle` is clipped
 * at two lines on screen, so a long description is otherwise neither shown nor
 * announced (Greptile #396 P1 — it reproduced this on an actionable row).
 *
 * Order is identity → state → description → caveat:
 *   "Subscription, Annual, Cancel or change your plan"
 * so the thing being named and its current value land first, before prose.
 */
export function deriveA11yLabel({
  title,
  value,
  showValue,
  accessoryLabel,
  subtitle,
  footnote,
}: {
  title: string;
  value?: string;
  /** The resolution's own verdict — a value that is not rendered is not spoken. */
  showValue?: boolean;
  /**
   * Spoken form of a CUSTOM accessory (a status badge, a plan name), which the
   * kit renders as opaque children and therefore cannot read. It occupies the
   * same "state" slot as `value` — the two are alternatives, never both.
   */
  accessoryLabel?: string;
  subtitle?: string;
  footnote?: string;
}): string {
  const state = showValue && value ? value : accessoryLabel;
  return [title, state, subtitle, footnote]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(', ');
}

// ─── Fragment flattening (ListSection) ───────────────────────────────────────
// React.Fragment's element type IS this well-known symbol — checking it by
// shape keeps this module import-free (no `import React`) while still
// recognizing both `<>` and `<React.Fragment>` children.

const REACT_FRAGMENT_TYPE = Symbol.for('react.fragment');

/** True for a React element whose type is the fragment symbol. */
export function isFragmentNode(node: unknown): boolean {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { type?: unknown }).type === REACT_FRAGMENT_TYPE
  );
}

/**
 * Recursively flattens fragment children into individual rows so ListSection
 * can compute adjacent pairs correctly: two ListRows wrapped in one fragment
 * must get a divider BETWEEN them, and a nested row's leftIcon must be seen
 * by the inset calculation (Greptile PR #389 P2 — React.Children.toArray
 * preserves a fragment as ONE entry, hiding both).
 *
 * Operates on raw ReactNode-shaped values without importing React: arrays and
 * fragments recurse; any other object is a leaf row; nulls/booleans/strings
 * are dropped (ListSection only renders real elements).
 */
export function flattenFragmentChildren(children: unknown): unknown[] {
  const out: unknown[] = [];
  function walk(node: unknown): void {
    if (node == null || typeof node === 'boolean') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (isFragmentNode(node)) {
      walk((node as { props?: { children?: unknown } }).props?.children);
      return;
    }
    if (typeof node === 'object') {
      out.push(node);
    }
    // strings/numbers are not rows — dropped
  }
  walk(children);
  return out;
}

/** Reads a row element's leftIcon prop — its presence drives the divider inset. */
export function rowLeftIcon(row: unknown): unknown {
  return (row as { props?: { leftIcon?: unknown } } | null)?.props?.leftIcon;
}
