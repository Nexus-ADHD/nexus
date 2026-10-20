// Tests for the four-box box-1 design ratchet (eslint-rules/four-box-design.js).
//
// Lives under scripts/__tests__ because that glob is already in vitest.config.ts;
// the rule itself sits in eslint-rules/ next to the ESLint config that loads it.
//
// The load path matters as much as the rule logic here. A rule that cannot read
// the scale would allow every value and look exactly like a clean run, so it
// throws instead. That is the same lesson as check-deploy-drift's exit 3.
import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../eslint-rules/four-box-design.js');

const SAMPLE = `
const space = {
  xxs:  4,
  xs:   8,
  md:   16,
} as const;
const radii = {
  sm:   8,
  full: 9999,
} as const;
const type = { body: { fontSize: 15 }, caption: { fontSize: 13 } };
const color = { gold: '#E5BA6E', teal: '#5FE0EA' };
`;

describe('parseScales', () => {
  it('reads every scale out of the token source rather than a copy', () => {
    const s = plugin.parseScales(SAMPLE, 'SAMPLE');
    expect([...s.spacing].sort((a: number, b: number) => a - b)).toEqual([4, 8, 16]);
    expect([...s.radii].sort((a: number, b: number) => a - b)).toEqual([8, 9999]);
    expect([...s.fontSizes].sort((a: number, b: number) => a - b)).toEqual([13, 15]);
  });

  for (const missing of ['space', 'radii', 'fontSize']) {
    it(`throws rather than allowing everything when ${missing} cannot be read`, () => {
      // The failure mode this prevents: an empty allow-set makes every value
      // legal, and the run looks identical to a clean one.
      const broken = SAMPLE.split('\n').filter((l) => !l.includes(missing)).join('\n');
      expect(() => plugin.parseScales(broken, 'BROKEN')).toThrow(/could not read/);
    });
  }
});

describe('the rules themselves', () => {
  const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  });

  // A TS parser is needed for the assertion spellings below: `13 as const` and
  // `{ ['padding' as const]: 13 }` are the same values wearing a type wrapper,
  // and each one is a different AST node that must not become a way past the
  // scale.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tsParser = require('@typescript-eslint/parser');
  const tsRuleTester = new RuleTester({
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
  });

  it('sees through TypeScript assertions on the key and on the value', () => {
    tsRuleTester.run('no-off-scale-spacing', plugin.rules['no-off-scale-spacing'], {
      valid: [
        { code: 'const s = { padding: 16 as const };' },
        { code: "const s = { ['padding' as const]: 16 };" },
      ],
      invalid: [
        { code: "const s = { ['padding' as const]: 13 };", errors: [{ messageId: 'offScale' }] },
        { code: "const s = { ['padding' as string]: 13 };", errors: [{ messageId: 'offScale' }] },
        { code: 'const s = { padding: 13 as const };', errors: [{ messageId: 'offScale' }] },
        { code: 'const s = { padding: 13 as number };', errors: [{ messageId: 'offScale' }] },
        { code: 'const s = { padding: (13 as number)! };', errors: [{ messageId: 'offScale' }] },
      ],
    });
  });

  it('flags an off-scale spacing value and allows an on-scale one', () => {
    ruleTester.run('no-off-scale-spacing', plugin.rules['no-off-scale-spacing'], {
      valid: [
        { code: 'const s = { padding: 16 };' },
        { code: 'const s = { marginTop: 24 };' },
        // 0 is the absence of the property, not a value off some other scale.
        { code: 'const s = { padding: 0 };' },
        // A negative margin is on-scale if its magnitude is.
        { code: 'const s = { marginLeft: -8 };' },
        // Not a literal: a token reference is the whole point.
        { code: 'const s = { padding: tokens.spacing.md };' },
        // Not a spacing key.
        { code: 'const s = { width: 13 };' },
        // A genuinely dynamic key cannot be known statically.
        { code: 'const s = { [k]: 13 };' },
      ],
      invalid: [
        { code: 'const s = { padding: 13 };', errors: [{ messageId: 'offScale' }] },
        { code: 'const s = { gap: 10 };', errors: [{ messageId: 'offScale' }] },
        { code: 'const s = { marginTop: -13 };', errors: [{ messageId: 'offScale' }] },
        // A computed key that is still static is the same property, and must
        // not be a way around the scale.
        { code: "const s = { ['padding']: 13 };", errors: [{ messageId: 'offScale' }] },
        { code: 'const s = { [`padding`]: 13 };', errors: [{ messageId: 'offScale' }] },
      ],
    });
  });

  it('flags an off-scale radius and font size', () => {
    ruleTester.run('no-off-scale-radius', plugin.rules['no-off-scale-radius'], {
      valid: [{ code: 'const s = { borderRadius: 16 };' }, { code: 'const s = { borderRadius: 9999 };' }],
      invalid: [{ code: 'const s = { borderRadius: 22 };', errors: [{ messageId: 'offScale' }] }],
    });
    ruleTester.run('no-off-scale-font-size', plugin.rules['no-off-scale-font-size'], {
      valid: [{ code: 'const s = { fontSize: 15 };' }, { code: 'const s = { fontSize: 9.5 };' }],
      invalid: [{ code: 'const s = { fontSize: 19 };', errors: [{ messageId: 'offScale' }] }],
    });
  });

  it('flags a transparent Modal but not a native presentation one', () => {
    const jsxTester = new RuleTester({
      languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    });
    const IMP = "import { Modal } from 'react-native';\n";
    jsxTester.run('no-raw-modal', plugin.rules['no-raw-modal'], {
      valid: [
        // Native presentation: the OS draws the surface, there is no scrim to
        // own, and a fullScreen modal must mount its own StarField. No
        // replacement exists, so flagging it would be a tax.
        { code: IMP + 'const a = <Modal visible animationType="slide" presentationStyle="formSheet" />;' },
        { code: IMP + 'const a = <Modal visible presentationStyle="fullScreen" />;' },
        { code: IMP + 'const a = <Modal visible transparent={false} />;' },
        // The primitive itself, and anything not a Modal.
        { code: IMP + 'const a = <Sheet visible onDismiss={f} accessibilityLabel="x" />;' },
        { code: IMP + 'const a = <View transparent />;' },
        // A Modal that is not react-native's is not this rule's business.
        { code: "import { Modal } from 'some-ui-kit';\nconst a = <Modal transparent />;" },
      ],
      invalid: [
        { code: IMP + 'const a = <Modal visible transparent />;', errors: [{ messageId: 'rawModal' }] },
        { code: IMP + 'const a = <Modal transparent={true} visible />;', errors: [{ messageId: 'rawModal' }] },
        // Aliased import — the spelling that walked past the first version.
        {
          code: "import { Modal as RNModal } from 'react-native';\nconst a = <RNModal transparent />;",
          errors: [{ messageId: 'rawModal' }],
        },
        // Namespaced import.
        {
          code: "import * as RN from 'react-native';\nconst a = <RN.Modal transparent />;",
          errors: [{ messageId: 'rawModal' }],
        },
        // A runtime value is transparent on some path. A false positive costs a
        // reply; a false negative costs the accessibility guarantees.
        {
          code: IMP + 'const a = <Modal transparent={isSheet} />;',
          errors: [{ messageId: 'rawModal' }],
        },
      ],
    });
  });

  it('flags a raw hex colour but not a tokenised one', () => {
    ruleTester.run('no-raw-hex', plugin.rules['no-raw-hex'], {
      valid: [
        { code: 'const c = tokens.color.gold;' },
        { code: "const c = 'not a colour';" },
      ],
      invalid: [
        { code: "const c = '#ff00aa';", errors: [{ messageId: 'rawHex' }] },
        { code: "const c = '#fff';", errors: [{ messageId: 'rawHex' }] },
        // A hex that IS a token value is still drift: the token is the
        // reference, not the value.
        { code: "const c = '#E5BA6E';", errors: [{ messageId: 'rawHex' }] },
      ],
    });
  });
});
