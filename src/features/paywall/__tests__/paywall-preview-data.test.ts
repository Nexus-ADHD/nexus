import { describe, expect, it } from 'vitest';
import {
  pickPreviewStats,
  REPRESENTATIVE_DAY_SCORES,
  REPRESENTATIVE_SCORE,
} from '../paywall-preview-data';

const KEYS7 = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];

describe('pickPreviewStats (NEX-121)', () => {
  it('uses the representative arc for an empty / new-user history', () => {
    const out = pickPreviewStats({}, KEYS7);
    expect(out.isRepresentative).toBe(true);
    expect(out.score).toBe(REPRESENTATIVE_SCORE);
    expect(out.dayScores.map((d) => d.score)).toEqual([...REPRESENTATIVE_DAY_SCORES]);
    // representative maps onto the provided keys
    expect(out.dayScores.map((d) => d.key)).toEqual(KEYS7);
  });

  it('uses representative when fewer than 2 real days exist', () => {
    const out = pickPreviewStats({ d7: 80 }, KEYS7);
    expect(out.isRepresentative).toBe(true);
  });

  it('uses the real shape when >= 2 real days exist', () => {
    const out = pickPreviewStats({ d2: 40, d5: 70, d7: 88 }, KEYS7);
    expect(out.isRepresentative).toBe(false);
    expect(out.dayScores.map((d) => d.score)).toEqual([null, 40, null, null, 70, null, 88]);
    // current score = most recent non-null
    expect(out.score).toBe(88);
  });

  it('clamps out-of-range real scores and treats non-numbers as null', () => {
    const out = pickPreviewStats({ d1: 140, d2: -5, d3: 'x' as unknown as number, d4: 60 }, KEYS7);
    expect(out.dayScores[0].score).toBe(100);
    expect(out.dayScores[1].score).toBe(0);
    expect(out.dayScores[2].score).toBe(null);
    expect(out.dayScores[3].score).toBe(60);
    expect(out.isRepresentative).toBe(false); // 3 valid real days (100,0,60)
  });

  it('is null/garbage-safe on the history arg', () => {
    expect(pickPreviewStats(null, KEYS7).isRepresentative).toBe(true);
    expect(pickPreviewStats(undefined, KEYS7).isRepresentative).toBe(true);
    expect(pickPreviewStats([] as unknown as Record<string, unknown>, KEYS7).isRepresentative).toBe(true);
  });
});
