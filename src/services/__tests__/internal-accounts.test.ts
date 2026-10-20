import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
import { parseInternalIds } from '../internal-accounts';

describe('parseInternalIds', () => {
  it('splits, trims, lowercases and drops blanks', () => {
    expect([...parseInternalIds(' AAA-1 , bbb-2,, ')]).toEqual(['aaa-1', 'bbb-2']);
  });
  it('is empty for missing config', () => {
    expect(parseInternalIds(undefined).size).toBe(0);
    expect(parseInternalIds('').size).toBe(0);
  });
});
