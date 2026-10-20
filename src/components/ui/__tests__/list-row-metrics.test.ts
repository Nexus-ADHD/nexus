import { describe, expect, it } from 'vitest';
import {
  defaultTrailing,
  deriveA11yLabel,
  DIVIDER_HEIGHT,
  DIVIDER_INSET_ICON,
  DIVIDER_INSET_PLAIN,
  dividerInsetLeft,
  flattenFragmentChildren,
  hasInteractiveAccessory,
  isFragmentNode,
  LEFT_ICON_GAP,
  LEFT_ICON_SIZE,
  resolveRowA11y,
  resolveTrailing,
  rowLeftIcon,
  ROW_MIN_HEIGHT,
  ROW_PADDING_HORIZONTAL,
  trailingMaxWidth,
} from '../list-row-metrics';

describe('geometry constants (spec block)', () => {
  it('row is minHeight 56 (not fixed height) with 16pt horizontal padding', () => {
    expect(ROW_MIN_HEIGHT).toBe(56);
    expect(ROW_PADDING_HORIZONTAL).toBe(16);
  });

  it('icon gutter is 20pt icon + 12pt gap', () => {
    expect(LEFT_ICON_SIZE).toBe(20);
    expect(LEFT_ICON_GAP).toBe(12);
  });

  it('divider is the 0.5pt hairline', () => {
    expect(DIVIDER_HEIGHT).toBe(0.5);
  });
});

describe('dividerInsetLeft', () => {
  it('plain row insets to the text column (row padding, 16)', () => {
    expect(dividerInsetLeft(false)).toBe(DIVIDER_INSET_PLAIN);
    expect(dividerInsetLeft(false)).toBe(16);
  });

  it('row with leftIcon insets past the icon gutter (16 + 20 + 12 = 48)', () => {
    expect(dividerInsetLeft(true)).toBe(DIVIDER_INSET_ICON);
    expect(dividerInsetLeft(true)).toBe(48);
  });
});

describe('resolveTrailing', () => {
  it('defaults to chevron', () => {
    expect(resolveTrailing({})).toEqual({
      kind: 'chevron',
      showValue: false,
      showChevron: true,
      showExternal: false,
      showCheck: false,
      showAccessory: false,
    });
  });

  it("value shows for trailing:'value'", () => {
    const r = resolveTrailing({ trailing: 'value', value: 'Free' });
    expect(r.showValue).toBe(true);
    expect(r.showChevron).toBe(false);
  });

  it("trailing:'value-chevron' shows value AND chevron", () => {
    const r = resolveTrailing({ trailing: 'value-chevron', value: 'Active' });
    expect(r.showValue).toBe(true);
    expect(r.showChevron).toBe(true);
  });

  it('precedence: value passed with a non-value kind is dropped', () => {
    for (const trailing of ['chevron', 'external', 'check', 'toggle', 'custom'] as const) {
      expect(resolveTrailing({ trailing, value: 'Free' }).showValue).toBe(false);
    }
  });

  it('missing or empty value never renders even for value kinds', () => {
    expect(resolveTrailing({ trailing: 'value' }).showValue).toBe(false);
    expect(resolveTrailing({ trailing: 'value-chevron', value: '' }).showValue).toBe(false);
  });

  it("external replaces the chevron (↗, never both)", () => {
    const r = resolveTrailing({ trailing: 'external' });
    expect(r.showExternal).toBe(true);
    expect(r.showChevron).toBe(false);
  });

  // The check marks a CHOICE, so it follows `selected` — an always-on check
  // would put a ✓ on every option in a picker (PickerRow, form-controls.md:30).
  it("trailing:'check' resolves to the teal check when SELECTED", () => {
    const r = resolveTrailing({ trailing: 'check', selected: true });
    expect(r.showCheck).toBe(true);
    expect(r.showChevron).toBe(false);
  });

  it("trailing:'check' on an unselected option shows nothing", () => {
    expect(resolveTrailing({ trailing: 'check', selected: false }).showCheck).toBe(false);
    expect(resolveTrailing({ trailing: 'check' }).showCheck).toBe(false);
  });

  it('selected does not conjure a check for any other kind', () => {
    for (const trailing of ['none', 'chevron', 'value', 'toggle', 'custom'] as const) {
      expect(resolveTrailing({ trailing, selected: true }).showCheck).toBe(false);
    }
  });

  it("trailing:'none' renders no trailing at all, whatever else is passed", () => {
    expect(
      resolveTrailing({ trailing: 'none', value: 'Free', trailingAccessory: { s: true } }),
    ).toEqual({
      kind: 'none',
      showValue: false,
      showChevron: false,
      showExternal: false,
      showCheck: false,
      showAccessory: false,
    });
  });

  it("accessory renders for trailing:'toggle' and trailing:'custom'", () => {
    const accessory = { sentinel: true }; // presence-only; metrics never inspects it
    expect(resolveTrailing({ trailing: 'toggle', trailingAccessory: accessory }).showAccessory).toBe(true);
    expect(resolveTrailing({ trailing: 'custom', trailingAccessory: accessory }).showAccessory).toBe(true);
  });

  it('precedence: accessory passed with a non-accessory kind is ignored', () => {
    const accessory = { sentinel: true };
    for (const trailing of ['chevron', 'value', 'value-chevron', 'external', 'check'] as const) {
      expect(resolveTrailing({ trailing, trailingAccessory: accessory }).showAccessory).toBe(false);
    }
  });

  it('accessory kinds without an accessory render nothing', () => {
    expect(resolveTrailing({ trailing: 'toggle' }).showAccessory).toBe(false);
    expect(resolveTrailing({ trailing: 'custom' }).showAccessory).toBe(false);
  });
});

describe('defaultTrailing (a chevron is a promise of navigation)', () => {
  it('an actionable row inherits the chevron', () => {
    expect(defaultTrailing(true)).toBe('chevron');
  });

  it('a row with no action inherits NOTHING — never a fake affordance', () => {
    // The regression this encodes: <ListRow title="No reminder lists found" />
    // shipped a › on a non-tappable empty state (apple-reminders.tsx:209).
    expect(defaultTrailing(false)).toBe('none');
  });
});

describe('resolveRowA11y (the three row shapes)', () => {
  const accessory = { sentinel: true };

  describe('shape 1 — the row IS the action', () => {
    it('is a pressable button element that honors disabled', () => {
      expect(resolveRowA11y({ hasAction: true, trailing: 'chevron' })).toEqual({
        pressable: true,
        accessible: true,
        passDisabled: true,
        role: 'button',
      });
    });

    it('a value row still reads label + value as one element', () => {
      const a = resolveRowA11y({ hasAction: true, trailing: 'value-chevron' });
      expect(a.accessible).toBe(true);
      expect(a.role).toBe('button');
    });
  });

  describe('shape 2 — static informational row', () => {
    it('is ONE element, unbuttoned, and never announces as disabled', () => {
      // "Version, 1.0.0" must keep reading as a single thing.
      expect(resolveRowA11y({ hasAction: false, trailing: 'value' })).toEqual({
        pressable: false,
        accessible: true,
        passDisabled: false,
        role: undefined,
      });
    });

    it('a STATIC custom accessory does not make the row a control host', () => {
      // Subscription's plan text and Apple Calendar's NATIVE badge are custom
      // accessories with nothing to reach — presence alone must not strip the
      // combined announcement off a read-only row.
      const a = resolveRowA11y({
        hasAction: false,
        trailing: 'custom',
        trailingAccessory: accessory,
      });
      expect(a.accessible).toBe(true);
      expect(a.pressable).toBe(false);
    });
  });

  describe('shape 3 — the row HOSTS a control', () => {
    it('a toggle row is not an element, so the switch stays reachable', () => {
      expect(
        resolveRowA11y({ hasAction: false, trailing: 'toggle', trailingAccessory: accessory }),
      ).toEqual({
        pressable: false,
        accessible: false,
        passDisabled: false,
        role: undefined,
      });
    });

    it('a custom accessory opts in explicitly (day-cycler, Resume, Connect)', () => {
      const a = resolveRowA11y({
        hasAction: false,
        trailing: 'custom',
        trailingAccessory: accessory,
        interactiveAccessory: true,
      });
      expect(a.accessible).toBe(false);
    });

    it('a toggle row that ALSO has a row action keeps the switch reachable', () => {
      // settings "Quotes in Notifications": hidden long-press test-send on a
      // row whose switch is the thing that actually matters.
      const a = resolveRowA11y({
        hasAction: true,
        trailing: 'toggle',
        trailingAccessory: accessory,
      });
      expect(a.pressable).toBe(true);
      expect(a.accessible).toBe(false);
      expect(a.role).toBe('button');
    });

    it('a toggle row can opt OUT if its accessory is somehow inert', () => {
      const a = resolveRowA11y({
        hasAction: false,
        trailing: 'toggle',
        trailingAccessory: accessory,
        interactiveAccessory: false,
      });
      expect(a.accessible).toBe(true);
    });

    it('an accessory kind with NO accessory hosts nothing', () => {
      expect(resolveRowA11y({ hasAction: false, trailing: 'toggle' }).accessible).toBe(true);
      expect(resolveRowA11y({ hasAction: false, trailing: 'custom' }).accessible).toBe(true);
    });

    it('an accessory on a non-accessory kind is not a control host', () => {
      for (const trailing of ['none', 'chevron', 'value', 'check'] as const) {
        expect(
          resolveRowA11y({
            hasAction: false,
            trailing,
            trailingAccessory: accessory,
            interactiveAccessory: true,
          }).accessible,
        ).toBe(true);
      }
    });
  });
});

describe('hasInteractiveAccessory (single-haptic rule)', () => {
  const accessory = { sentinel: true };

  it('toggle/custom accessory present → row press haptic suppressed', () => {
    expect(hasInteractiveAccessory('toggle', accessory)).toBe(true);
    expect(hasInteractiveAccessory('custom', accessory)).toBe(true);
  });

  it('accessory on a non-accessory kind does NOT suppress the row haptic', () => {
    expect(hasInteractiveAccessory('chevron', accessory)).toBe(false);
    expect(hasInteractiveAccessory('value-chevron', accessory)).toBe(false);
  });

  it('toggle/custom kinds without an accessory keep the row haptic', () => {
    expect(hasInteractiveAccessory('toggle')).toBe(false);
    expect(hasInteractiveAccessory('custom', undefined)).toBe(false);
  });
});

describe('deriveA11yLabel', () => {
  it('plain row announces the title alone', () => {
    expect(deriveA11yLabel({ title: 'Phone Number' })).toBe('Phone Number');
  });

  it('value announced with the label when shown', () => {
    expect(deriveA11yLabel({ title: 'Subscription', value: 'Active', showValue: true })).toBe(
      'Subscription, Active',
    );
  });

  it('value passed but not shown is NOT announced (precedence)', () => {
    expect(deriveA11yLabel({ title: 'Phone Number', value: '+1 555', showValue: false })).toBe(
      'Phone Number',
    );
  });

  it('toggle rows never double-announce (no value, title only)', () => {
    expect(deriveA11yLabel({ title: 'Milestone Alerts' })).toBe('Milestone Alerts');
  });

  // A row that IS one accessibility element speaks only its label, so anything
  // rendered inside it and absent from the label is silent to a screen reader.
  it('a footnote is announced, never left silent inside the row', () => {
    expect(
      deriveA11yLabel({
        title: 'Google Calendar',
        footnote: 'OAuth client id not configured.',
      }),
    ).toBe('Google Calendar, OAuth client id not configured.');
  });

  // #396 P1: the subtitle is CLIPPED at two lines on screen, so leaving it out
  // of the label means the tail of a long description is neither shown NOR
  // announced — the row's own copy goes missing for a screen-reader user.
  it('the subtitle is announced in full even though the layout clips it', () => {
    const long =
      'Off by default. Your progress stays cumulative and a miss takes nothing away. ' +
      'Soft Mode shows a day count with one free miss. You can switch back anytime.';
    expect(deriveA11yLabel({ title: 'Soft Mode', subtitle: long })).toBe(`Soft Mode, ${long}`);
  });

  // #396 P1 round 2: naming a custom accessory must NOT cost the subtitle.
  // The Apple Calendar row hand-rolled a full accessibilityLabel to say
  // "native", which skipped derivation entirely and silently dropped
  // "Read through iOS EventKit permissions."
  it('an accessory label occupies the state slot and keeps the subtitle', () => {
    expect(
      deriveA11yLabel({
        title: 'Apple Calendar',
        accessoryLabel: 'native',
        subtitle: 'Read through iOS EventKit permissions.',
      }),
    ).toBe('Apple Calendar, native, Read through iOS EventKit permissions.');
  });

  it('a shown value wins the state slot over an accessory label', () => {
    expect(
      deriveA11yLabel({
        title: 'Plan',
        value: 'Annual',
        showValue: true,
        accessoryLabel: 'ignored',
      }),
    ).toBe('Plan, Annual');
  });

  it('an accessory label fills the state slot when no value is shown', () => {
    expect(
      deriveA11yLabel({ title: 'rive-react-native', accessoryLabel: 'ready' }),
    ).toBe('rive-react-native, ready');
  });

  it('orders identity, then state, then description, then caveat', () => {
    expect(
      deriveA11yLabel({
        title: 'Subscription',
        value: 'Annual',
        showValue: true,
        subtitle: 'Cancel or change your plan',
        footnote: 'Renews in 3 days',
      }),
    ).toBe('Subscription, Annual, Cancel or change your plan, Renews in 3 days');
  });

  it('empty strings never produce a dangling separator', () => {
    expect(
      deriveA11yLabel({ title: 'Version', value: '', showValue: true, subtitle: '' }),
    ).toBe('Version');
  });

  it('no extras leaves the label untouched', () => {
    expect(deriveA11yLabel({ title: 'Version', value: '1.0.0', showValue: true })).toBe(
      'Version, 1.0.0',
    );
  });
});

// Minimal element-shaped stand-ins: the metrics module is import-free, so the
// tests build raw objects with the same shape React elements have (a `type`,
// `props`, `key`) instead of JSX — fragments are the well-known symbol.
const FRAGMENT_TYPE = Symbol.for('react.fragment');
const row = (props: Record<string, unknown> = {}, key: string | null = null) => ({
  type: 'ListRow',
  props,
  key,
});
const fragment = (children: unknown) => ({
  type: FRAGMENT_TYPE,
  props: { children },
  key: null,
});

describe('isFragmentNode', () => {
  it('recognizes the react.fragment symbol by shape', () => {
    expect(isFragmentNode(fragment([row()]))).toBe(true);
  });

  it('plain rows, arrays and nulls are not fragments', () => {
    expect(isFragmentNode(row())).toBe(false);
    expect(isFragmentNode([fragment([])])).toBe(false);
    expect(isFragmentNode(null)).toBe(false);
  });
});

describe('flattenFragmentChildren', () => {
  it('passes plain rows through untouched', () => {
    const rows = [row(), row(), row()];
    expect(flattenFragmentChildren(rows)).toEqual(rows);
  });

  it('a fragment of two rows flattens to two individual rows (divider between them)', () => {
    const a = row({ title: 'A' });
    const b = row({ title: 'B' });
    const flattened = flattenFragmentChildren([fragment([a, b])]);
    expect(flattened).toEqual([a, b]);
    // Two adjacent leaf rows = one divider pair; a single preserved fragment
    // entry would have rendered none.
    expect(flattened).toHaveLength(2);
  });

  it('flattens nested fragments recursively', () => {
    const a = row({ title: 'A' });
    const b = row({ title: 'B' });
    const c = row({ title: 'C' });
    expect(
      flattenFragmentChildren([a, fragment([b, fragment(c)])]),
    ).toEqual([a, b, c]);
  });

  it('drops null/boolean/string children (ListSection renders elements only)', () => {
    const a = row();
    expect(flattenFragmentChildren([a, null, false, undefined, 'stray text'])).toEqual([a]);
    expect(flattenFragmentChildren(fragment([null, a, false]))).toEqual([a]);
  });

  it("flattened rows keep their props, so a fragment-nested leftIcon insets the divider to 48", () => {
    const withIcon = row({ leftIcon: { glyph: true } });
    const plain = row();
    const flattened = flattenFragmentChildren([fragment([withIcon, plain])]);
    expect(rowLeftIcon(flattened[0])).not.toBeNull();
    expect(dividerInsetLeft(rowLeftIcon(flattened[0]) != null)).toBe(DIVIDER_INSET_ICON);
    expect(dividerInsetLeft(rowLeftIcon(flattened[1]) != null)).toBe(DIVIDER_INSET_PLAIN);
  });
});

describe('rowLeftIcon', () => {
  it('reads the leftIcon prop off a row element', () => {
    expect(rowLeftIcon(row({ leftIcon: 'x' }))).toBe('x');
    expect(rowLeftIcon(row())).toBeUndefined();
    expect(rowLeftIcon(null)).toBeUndefined();
  });
});

describe('list row — the trailing width cap', () => {
  // The 45% default is a structural backstop: an accessory that ignores
  // TRAILING_MAX_SCALE can still only shrink the text column so far. A control
  // CLUSTER (two Steppers + separator + meridiem, ~168pt) is the one case that
  // legitimately needs more, and it opts in explicitly. (#422 P1.)

  it('defaults to the cap that protects the label', () => {
    expect(trailingMaxWidth()).toBe('45%');
    expect(trailingMaxWidth(false)).toBe('45%');
  });

  it('fits a two-Stepper time cluster when a row opts in', () => {
    const pct = parseFloat(trailingMaxWidth(true));
    const NARROWEST = 320 - 2 * 16; // iPhone SE content width
    const CLUSTER_PT = 168;         // two Steppers + separator + meridiem
    expect((pct / 100) * (393 - 2 * 16)).toBeGreaterThan(CLUSTER_PT);
    // and the label still keeps a real share, never crowded out
    expect(pct).toBeLessThan(70);
    expect(((100 - pct) / 100) * NARROWEST).toBeGreaterThan(100);
  });

  it('never lets the opt-in fall back below the default', () => {
    expect(parseFloat(trailingMaxWidth(true))).toBeGreaterThan(
      parseFloat(trailingMaxWidth(false)),
    );
  });
});
