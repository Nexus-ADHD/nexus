import { describe, it, expect } from 'vitest';
import { mandateContext, MAX_MANDATES, MAX_MANDATE_CHARS } from '../notification-mandate-context';

describe('mandateContext', () => {
  it('takes active pillar titles only, trimmed', () => {
    const { mandates } = mandateContext([
      { title: '  I ship before noon  ' },
      { title: 'I move daily', completed: true }, // completed → excluded
      { title: '' }, // empty → excluded
      { title: 'I read every night' },
      { notes: 'no title' } as any, // no title → excluded
    ]);
    expect(mandates).toEqual(['I ship before noon', 'I read every night']);
  });

  it('caps the count and the per-mandate length', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `Mandate ${i} ` + 'x'.repeat(200) }));
    const { mandates } = mandateContext(many);
    expect(mandates).toHaveLength(MAX_MANDATES);
    for (const m of mandates) expect(m.length).toBeLessThanOrEqual(MAX_MANDATE_CHARS);
  });

  it('hash is stable for the same content and changes when a mandate changes', () => {
    const a = mandateContext([{ title: 'I ship before noon' }, { title: 'I read nightly' }]);
    const b = mandateContext([{ title: 'I ship before noon' }, { title: 'I read nightly' }]);
    const c = mandateContext([{ title: 'I ship before noon' }, { title: 'I read at dawn' }]);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it('hash is order-sensitive (reordering evicts)', () => {
    const a = mandateContext([{ title: 'Alpha here' }, { title: 'Beta here' }]);
    const b = mandateContext([{ title: 'Beta here' }, { title: 'Alpha here' }]);
    expect(a.hash).not.toBe(b.hash);
  });

  it('handles empty / garbage input with a stable empty result', () => {
    expect(mandateContext([]).mandates).toEqual([]);
    expect(mandateContext(null).mandates).toEqual([]);
    expect(mandateContext(undefined as any).mandates).toEqual([]);
    expect(mandateContext([]).hash).toBe(mandateContext(null).hash);
  });
});
