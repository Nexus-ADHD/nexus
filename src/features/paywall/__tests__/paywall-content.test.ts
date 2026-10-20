// Tests for the paywall remote-content resolver. Pure module (no RN imports),
// runs under the pure-Node vitest config.
import { describe, it, expect } from 'vitest';
import { resolvePaywallContent, DEFAULT_PAYWALL_CONTENT } from '../paywall-content';

describe('resolvePaywallContent', () => {
  it('returns exact defaults for undefined/empty metadata', () => {
    expect(resolvePaywallContent(undefined)).toEqual(DEFAULT_PAYWALL_CONTENT);
    expect(resolvePaywallContent({})).toEqual(DEFAULT_PAYWALL_CONTENT);
  });

  it('locks the byte-for-byte default strings', () => {
    expect(DEFAULT_PAYWALL_CONTENT).toEqual({
      variant: 'standard',
      tagline: 'REMEMBER WHO YOU ARE',
      headline: 'Become the you\nthat already exists',
      features: [
        'AI Morning Brief & Daily Pulse',
        'Voice Command — speak to act',
        'Weekly, Monthly & Annual Reviews',
        'Unlimited habits & mandates',
        'Cloud backup & device sync',
        'Personalized daily wisdom',
      ],
      planSubtexts: { annual: 'Best value · Save 44%', monthly: 'Cancel anytime' },
      bestValueBadge: 'BEST VALUE',
    });
  });

  it('applies a full override', () => {
    const out = resolvePaywallContent({
      tagline: 'BECOME WHO YOU ARE',
      headline: 'Everything\nin one place',
      features: ['One', 'Two', 'Three'],
      planSubtexts: { annual: 'Save big', monthly: 'Flexible' },
      bestValueBadge: 'POPULAR',
    });
    expect(out).toEqual({
      variant: 'standard',
      tagline: 'BECOME WHO YOU ARE',
      headline: 'Everything\nin one place',
      features: ['One', 'Two', 'Three'],
      planSubtexts: { annual: 'Save big', monthly: 'Flexible' },
      bestValueBadge: 'POPULAR',
    });
  });

  // NEX-121: remote-selectable layout variant.
  it('resolves the variant only for the exact literal data_preview', () => {
    expect(resolvePaywallContent({ variant: 'data_preview' }).variant).toBe('data_preview');
    // default + anything malformed → standard (never strand a user on a broken variant)
    expect(resolvePaywallContent(undefined).variant).toBe('standard');
    expect(resolvePaywallContent({}).variant).toBe('standard');
    expect(resolvePaywallContent({ variant: 'DATA_PREVIEW' }).variant).toBe('standard');
    expect(resolvePaywallContent({ variant: 'blurred' }).variant).toBe('standard');
    expect(resolvePaywallContent({ variant: 123 }).variant).toBe('standard');
    expect(resolvePaywallContent({ variant: true }).variant).toBe('standard');
  });

  it('falls back per-field on a partial override', () => {
    const out = resolvePaywallContent({ headline: 'Just this' });
    expect(out.headline).toBe('Just this');
    expect(out.tagline).toBe(DEFAULT_PAYWALL_CONTENT.tagline);
    expect(out.features).toEqual(DEFAULT_PAYWALL_CONTENT.features);
    expect(out.planSubtexts).toEqual(DEFAULT_PAYWALL_CONTENT.planSubtexts);
    expect(out.bestValueBadge).toBe(DEFAULT_PAYWALL_CONTENT.bestValueBadge);
  });

  it('normalizes a literal \\n in the headline into a newline', () => {
    const out = resolvePaywallContent({ headline: 'Line one\\nLine two' });
    expect(out.headline).toBe('Line one\nLine two');
  });

  it('rejects a headline that exceeds the cap only after \\n expansion', () => {
    // 5 segments joined by literal "\n" → expands past CAP.headline (48).
    const seg = 'twelve chars';
    const headline = [seg, seg, seg, seg].join('\\n'); // 4×12 + 3×1 = 51 > 48
    expect(resolvePaywallContent({ headline }).headline).toBe(DEFAULT_PAYWALL_CONTENT.headline);
  });

  it('rejects a headline with more than two lines even when short (2-line budget)', () => {
    expect(resolvePaywallContent({ headline: 'A\\nB\\nC' }).headline).toBe(DEFAULT_PAYWALL_CONTENT.headline);
    // exactly two lines is allowed
    expect(resolvePaywallContent({ headline: 'A\\nB' }).headline).toBe('A\nB');
  });

  it('rejects a newline in single-line fields (tagline/feature/subtext/badge)', () => {
    expect(resolvePaywallContent({ tagline: 'TWO\nLINES' }).tagline).toBe(DEFAULT_PAYWALL_CONTENT.tagline);
    expect(resolvePaywallContent({ bestValueBadge: 'TWO\nLINES' }).bestValueBadge).toBe(DEFAULT_PAYWALL_CONTENT.bestValueBadge);
    expect(resolvePaywallContent({ features: ['ok one', 'bad\ntwo', 'ok three'] }).features).toEqual(['ok one', 'ok three']);
    expect(resolvePaywallContent({ planSubtexts: { annual: 'multi\nline' } }).planSubtexts.annual).toBe(
      DEFAULT_PAYWALL_CONTENT.planSubtexts.annual,
    );
  });

  it('trims override strings and rejects empty/whitespace', () => {
    expect(resolvePaywallContent({ tagline: '  SPACED  ' }).tagline).toBe('SPACED');
    expect(resolvePaywallContent({ tagline: '   ' }).tagline).toBe(DEFAULT_PAYWALL_CONTENT.tagline);
  });

  it('rejects over-long strings (fixed-frame guard)', () => {
    const tooLong = 'x'.repeat(200);
    expect(resolvePaywallContent({ tagline: tooLong }).tagline).toBe(DEFAULT_PAYWALL_CONTENT.tagline);
    expect(resolvePaywallContent({ headline: tooLong }).headline).toBe(DEFAULT_PAYWALL_CONTENT.headline);
    expect(resolvePaywallContent({ bestValueBadge: tooLong }).bestValueBadge).toBe(DEFAULT_PAYWALL_CONTENT.bestValueBadge);
  });

  it('filters non-string / empty / over-long feature items and caps at 6', () => {
    const out = resolvePaywallContent({
      features: ['Good one', 42, '', '   ', null, { x: 1 }, 'x'.repeat(80), 'Good two'],
    });
    expect(out.features).toEqual(['Good one', 'Good two']);

    const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(resolvePaywallContent({ features: eight }).features).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('falls back to default features when the array yields nothing usable', () => {
    expect(resolvePaywallContent({ features: [] }).features).toEqual(DEFAULT_PAYWALL_CONTENT.features);
    expect(resolvePaywallContent({ features: [42, '', null] }).features).toEqual(DEFAULT_PAYWALL_CONTENT.features);
    expect(resolvePaywallContent({ features: 'not an array' }).features).toEqual(DEFAULT_PAYWALL_CONTENT.features);
  });

  it('resolves planSubtexts per-key with independent fallback', () => {
    expect(resolvePaywallContent({ planSubtexts: { annual: 'Cheapest yearly' } }).planSubtexts).toEqual({
      annual: 'Cheapest yearly',
      monthly: DEFAULT_PAYWALL_CONTENT.planSubtexts.monthly,
    });
    // wrong-typed planSubtexts → both defaults
    expect(resolvePaywallContent({ planSubtexts: 'nope' }).planSubtexts).toEqual(DEFAULT_PAYWALL_CONTENT.planSubtexts);
    expect(resolvePaywallContent({ planSubtexts: { annual: 99, monthly: null } }).planSubtexts).toEqual(
      DEFAULT_PAYWALL_CONTENT.planSubtexts,
    );
  });

  it('never throws and returns defaults for non-object metadata (string/number/null/array/bool)', () => {
    for (const bad of ['a string', 42, null, true, ['a', 'b'], NaN]) {
      expect(() => resolvePaywallContent(bad)).not.toThrow();
      expect(resolvePaywallContent(bad)).toEqual(DEFAULT_PAYWALL_CONTENT);
    }
  });

  it('never throws on nested wrong-typed fields and degrades to defaults', () => {
    const hostile = { tagline: { nested: true }, headline: [1, 2], features: { 0: 'x' }, planSubtexts: [1], bestValueBadge: 3 };
    expect(() => resolvePaywallContent(hostile)).not.toThrow();
    expect(resolvePaywallContent(hostile)).toEqual(DEFAULT_PAYWALL_CONTENT);
  });
});
