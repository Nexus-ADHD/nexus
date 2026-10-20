import { describe, expect, it } from 'vitest';
import { barColorForScore, barHeightForScore, kpiColorForRate } from '../weekly-debrief-chart-helpers';
import tokens from '@/src/theme/tokens';

describe('barColorForScore (NEX-121, mirrors Home thresholds)', () => {
  it('maps score tiers to the v3 palette', () => {
    expect(barColorForScore(85)).toBe(tokens.color.teal);     // >=80
    expect(barColorForScore(80)).toBe(tokens.color.teal);
    expect(barColorForScore(65)).toBe(tokens.color.gold);     // 50-79
    expect(barColorForScore(50)).toBe(tokens.color.gold);
    expect(barColorForScore(20)).toBe(tokens.color.textMuted); // <50, never red (Law C)
  });
  it('uses the gray stub color for null / non-finite (paused/missing)', () => {
    expect(barColorForScore(null)).toBe(tokens.color.surfaceElevated);
    expect(barColorForScore(NaN)).toBe(tokens.color.surfaceElevated);
  });
});

describe('kpiColorForRate (KPI tiles — 70/40 tiers, distinct from the bar tiers)', () => {
  it('maps rate tiers to the v3 palette', () => {
    expect(kpiColorForRate(85)).toBe(tokens.color.teal);     // >=70
    expect(kpiColorForRate(70)).toBe(tokens.color.teal);
    expect(kpiColorForRate(55)).toBe(tokens.color.gold);     // >=40
    expect(kpiColorForRate(40)).toBe(tokens.color.gold);
    expect(kpiColorForRate(20)).toBe(tokens.color.textMuted); // <40, never red
  });
  it('treats non-finite (e.g. a null avg score) as the muted tier, matching Home', () => {
    expect(kpiColorForRate(NaN)).toBe(tokens.color.textMuted);
    expect(kpiColorForRate(null as unknown as number)).toBe(tokens.color.textMuted);
  });
});

describe('barHeightForScore (NEX-121)', () => {
  it('is proportional to score/100 over the max height', () => {
    expect(barHeightForScore(100, 44)).toBe(44);
    expect(barHeightForScore(50, 44)).toBe(22);
  });
  it('floors at minHeight for low / null / out-of-range', () => {
    expect(barHeightForScore(0, 44)).toBe(4);
    expect(barHeightForScore(null, 44)).toBe(4);
    expect(barHeightForScore(-10, 44)).toBe(4);
    expect(barHeightForScore(200, 44)).toBe(44); // clamped to 100
    expect(barHeightForScore(null, 44, 6)).toBe(6);
  });
});
