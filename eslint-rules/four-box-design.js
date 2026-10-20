// Four-box gate, box 1 (UI/UX): the design-drift ratchet.
//
// The rule this enforces is defined in docs/automation/four-box-gate.md and is
// NOT restated here. This file is the mechanism; that file is the policy.
//
// RATCHETING IS NOT IMPLEMENTED HERE. These are ordinary ESLint errors.
// scripts/lint-changed-lines.mjs (NEX-115) already filters ESLint errors to a
// PR's changed lines, so pre-existing drift in a touched file never blocks a PR
// that did not introduce it. A second ratchet here would be a second source of
// truth about what counts as "changed" — the defect class this repo keeps
// paying for. One ratchet, reused.
//
// THE ALLOWED VALUES ARE READ FROM src/theme/tokens.ts, NOT COPIED. A copied
// scale drifts from the scale it claims to enforce. If the parse finds nothing,
// this module THROWS: a rule that silently allows every value because it could
// not read the scale would look exactly like a clean run, which is the failure
// mode the deploy-drift work spent four review rounds on.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const TOKENS_PATH = join(__dirname, '..', 'src', 'theme', 'tokens.ts');

/** Numbers inside a named `const <name> = { ... }` object literal in tokens.ts. */
function scaleFrom(source, name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start === -1) return [];
  const end = source.indexOf('}', start);
  if (end === -1) return [];
  return [
    ...source.slice(start, end).matchAll(/:\s*(-?\d+(?:\.\d+)?)\s*,/g),
  ].map((m) => Number(m[1]));
}

function parseScales(src, where = TOKENS_PATH) {
  const spacing = scaleFrom(src, 'space');
  const radii = scaleFrom(src, 'radii');
  const fontSizes = [...src.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));

  // A floor on every scale. "Found nothing" and "the scale is empty" must not
  // look the same, and an empty allow-set would make every value legal.
  const empty = Object.entries({ spacing, radii, fontSizes })
    .filter(([, v]) => v.length === 0)
    .map(([k]) => k);
  if (empty.length) {
    throw new Error(
      `four-box-design: could not read ${empty.join(', ')} from ${where}. ` +
        'Refusing to load rather than silently allow every value.',
    );
  }

  return {
    spacing: new Set(spacing),
    radii: new Set(radii),
    fontSizes: new Set(fontSizes),
  };
}

const SCALES = parseScales(readFileSync(TOKENS_PATH, 'utf8'));

const SPACING_KEYS = new Set([
  'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'paddingHorizontal', 'paddingVertical', 'paddingStart', 'paddingEnd',
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'marginHorizontal', 'marginVertical', 'marginStart', 'marginEnd',
  'gap', 'rowGap', 'columnGap',
]);

const RADIUS_KEYS = new Set([
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius',
  'borderBottomLeftRadius', 'borderBottomRightRadius',
  'borderTopStartRadius', 'borderTopEndRadius',
  'borderBottomStartRadius', 'borderBottomEndRadius',
]);

const HEX = /^#[0-9a-fA-F]{3,8}$/;

/**
 * Strip TypeScript wrappers that change a node's type but not its value.
 *
 * `13 as const`, `13 as number`, `<number>13` and `13!` are all the number 13.
 * Every one of them is a different AST node, and treating any of them as
 * unknowable is a spelling that walks past the scale. Applied on BOTH sides of
 * a property — the key and the value — because either wrapper hides the same
 * fact.
 */
function unwrapTs(node) {
  let n = node;
  while (
    n &&
    (n.type === 'TSAsExpression' ||
      n.type === 'TSSatisfiesExpression' ||
      n.type === 'TSNonNullExpression' ||
      n.type === 'TSTypeAssertion' ||
      n.type === 'TSInstantiationExpression')
  ) {
    n = n.expression;
  }
  return n;
}

/** The numeric value of a property, unwrapping a unary minus. Null if not literal. */
function numericValue(node) {
  const n = unwrapTs(node);
  if (!n) return null;
  if (n.type === 'Literal' && typeof n.value === 'number') return n.value;
  if (n.type === 'UnaryExpression' && n.operator === '-') {
    const inner = numericValue(n.argument);
    return inner === null ? null : -inner;
  }
  return null;
}

/**
 * The property name, or null when it genuinely cannot be known statically.
 *
 * A computed key is not automatically unknowable: `{ ['padding']: 13 }` and
 * `` { [`padding`]: 13 } `` and `{ ['padding' as const]: 13 }` are the same
 * property as `{ padding: 13 }`. Treating any of those as unknowable made them
 * a way around the scale while the plain spelling was rejected — a silent hole
 * in a check whose whole job is to not have one. Only a key whose value
 * depends on runtime is null.
 */
function keyName(prop) {
  const key = unwrapTs(prop.key);
  if (!key) return null;
  if (prop.computed) {
    if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
    if (key.type === 'TemplateLiteral' && key.expressions.length === 0 && key.quasis.length === 1) {
      return key.quasis[0].value.cooked;
    }
    return null;
  }
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal') return String(key.value);
  return null;
}

/** One rule shape for all three numeric scales. */
function offScaleRule({ keys, scale, label, tokenPath }) {
  return {
    meta: {
      type: 'problem',
      docs: { description: `${label} must come from the ${tokenPath} scale` },
      schema: [],
      messages: {
        offScale:
          "{{key}}: {{value}} is off the {{label}} scale. Use {{tokenPath}} " +
          '(allowed: {{allowed}}). See docs/automation/four-box-gate.md.',
      },
    },
    create(context) {
      return {
        Property(node) {
          const key = keyName(node);
          if (!key || !keys.has(key)) return;
          const value = numericValue(node.value);
          if (value === null) return;
          // 0 is never drift: it is the absence of the property, not a value
          // picked off some other scale.
          if (value === 0) return;
          if (scale.has(Math.abs(value))) return;
          context.report({
            node: node.value,
            messageId: 'offScale',
            data: {
              key,
              value: String(value),
              label,
              tokenPath,
              allowed: [...scale].sort((a, b) => a - b).join(', '),
            },
          });
        },
      };
    },
  };
}

module.exports = {
  // Exported for tests: the fail-loud path is the important one.
  parseScales,
  rules: {

    /**
     * A transparent <Modal> is a sheet, and there is now a primitive for it.
     *
     * Scoped to `transparent` on purpose. The 10 modals using
     * presentationStyle="formSheet" or "fullScreen" are NOT drift: the OS draws
     * those surfaces, there is no scrim to own, and a fullScreen modal has to
     * mount its own StarField because it renders above the global one. Flagging
     * them would be a rule with no replacement to offer, which is a tax rather
     * than a ratchet.
     */
    'no-raw-modal': {
      meta: {
        type: 'problem',
        docs: { description: 'a transparent Modal is a Sheet; use the primitive' },
        schema: [],
        messages: {
          rawModal:
            'A transparent <Modal> is a sheet. Use <Sheet> from ' +
            '@/src/components/ui/Sheet, which owns the scrim, the focus trap, the ' +
            'Android back button and keyboard avoidance. Native presentationStyle ' +
            'modals are not affected. See docs/automation/four-box-gate.md.',
        },
      },
      create(context) {
        // Resolve what react-native's Modal is actually CALLED in this file.
        // Matching the bare identifier `Modal` missed `import { Modal as RNModal }`
        // and `import * as RN` + `<RN.Modal>`. Enumerating the spellings is the
        // point of a ratchet; a rule that only catches the obvious one is a
        // suggestion.
        const localNames = new Set();
        const namespaces = new Set();

        function isModalElement(name) {
          if (name.type === 'JSXIdentifier') return localNames.has(name.name);
          if (name.type === 'JSXMemberExpression') {
            return (
              name.object.type === 'JSXIdentifier' &&
              namespaces.has(name.object.name) &&
              name.property.type === 'JSXIdentifier' &&
              name.property.name === 'Modal'
            );
          }
          return false;
        }

        return {
          ImportDeclaration(node) {
            if (node.source.value !== 'react-native') return;
            for (const spec of node.specifiers) {
              if (spec.type === 'ImportSpecifier' && spec.imported.name === 'Modal') {
                localNames.add(spec.local.name);
              } else if (spec.type === 'ImportNamespaceSpecifier') {
                namespaces.add(spec.local.name);
              }
            }
          },

          JSXOpeningElement(node) {
            if (!isModalElement(node.name)) return;

            const attr = node.attributes.find(
              (a) =>
                a.type === 'JSXAttribute' &&
                a.name.type === 'JSXIdentifier' &&
                a.name.name === 'transparent',
            );
            if (!attr) return;

            // Only an explicit `transparent={false}` is exempt. A runtime value
            // like `transparent={isSheet}` is transparent on some path, so it
            // is flagged: a false positive costs a reply, a false negative
            // costs the accessibility guarantees this primitive exists for.
            const isExplicitlyFalse =
              attr.value !== null &&
              attr.value.type === 'JSXExpressionContainer' &&
              attr.value.expression.type === 'Literal' &&
              attr.value.expression.value === false;
            if (isExplicitlyFalse) return;

            context.report({ node, messageId: 'rawModal' });
          },
        };
      },
    },

    'no-raw-hex': {
      meta: {
        type: 'problem',
        docs: { description: 'colour must come from tokens.color, not a raw hex literal' },
        schema: [],
        messages: {
          rawHex:
            '{{hex}} is a raw hex colour. Use tokens.color. A hex that happens to match ' +
            'a token is still drift: the token is the reference, not the value. ' +
            'See docs/automation/four-box-gate.md.',
        },
      },
      create(context) {
        // Deliberately NOT "any hex not in tokens.ts". Pasting the gold value
        // instead of referencing tokens.color.gold is exactly the drift this
        // box exists to stop, and an allowlist of known-good hexes would wave
        // it through. tokens.ts is excluded in eslint.config.js instead: it is
        // where the values are allowed to live.
        return {
          Literal(node) {
            if (typeof node.value !== 'string') return;
            if (!HEX.test(node.value)) return;
            context.report({ node, messageId: 'rawHex', data: { hex: node.value } });
          },
        };
      },
    },

    'no-off-scale-font-size': offScaleRule({
      keys: new Set(['fontSize']),
      scale: SCALES.fontSizes,
      label: 'type',
      tokenPath: 'tokens.type',
    }),

    'no-off-scale-spacing': offScaleRule({
      keys: SPACING_KEYS,
      scale: SCALES.spacing,
      label: 'spacing',
      tokenPath: 'tokens.spacing',
    }),

    'no-off-scale-radius': offScaleRule({
      keys: RADIUS_KEYS,
      scale: SCALES.radii,
      label: 'radius',
      tokenPath: 'tokens.radii',
    }),
  },
};
