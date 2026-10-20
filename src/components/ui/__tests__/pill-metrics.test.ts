import { describe, expect, it } from 'vitest';
import { resolvePillMetrics } from '../pill-metrics';

describe('resolvePillMetrics', () => {
  it('default size: 56pt height, 32pt horizontal padding, 200pt minWidth floor, no fill', () => {
    expect(resolvePillMetrics('default', false)).toEqual({
      height: 56,
      paddingHorizontal: 32,
      minWidth: 200,
      fillWidth: false,
    });
  });

  it('compact size: 44pt height, 20pt horizontal padding, no minWidth floor, no fill', () => {
    expect(resolvePillMetrics('compact', false)).toEqual({
      height: 44,
      paddingHorizontal: 20,
      minWidth: undefined,
      fillWidth: false,
    });
  });

  it('fullWidth drops the minWidth floor AND stretches the painted body (fillWidth)', () => {
    const m = resolvePillMetrics('default', true);
    expect(m.minWidth).toBeUndefined();
    expect(m.fillWidth).toBe(true);
    expect(m.height).toBe(56);
    expect(m.paddingHorizontal).toBe(32);
  });

  it('fullWidth compact stays compact, stretches the painted body, still no floor', () => {
    const m = resolvePillMetrics('compact', true);
    expect(m).toEqual({
      height: 44,
      paddingHorizontal: 20,
      minWidth: undefined,
      fillWidth: true,
    });
  });
});
