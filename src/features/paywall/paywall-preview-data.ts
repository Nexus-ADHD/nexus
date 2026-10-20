// Pure (no RN) data layer for the NEX-121 "paywall as content" preview —
// vitest-testable. Decides between the user's REAL alignment shape and a
// representative arc, and exposes only the SHAPE (daily scores + a current
// score). No readable values are rendered by the preview; this just supplies the
// arc/bar geometry.

export interface PreviewDay {
  key: string;
  /** null = paused / missing day (stub bar). */
  score: number | null;
}

export interface PreviewStats {
  dayScores: PreviewDay[];
  /** Drives the ring arc fill. */
  score: number;
  /** True when dayScores/score are the representative arc, NOT the user's data. */
  isRepresentative: boolean;
}

// Representative Quiet→Rising 7-day arc for new / sparse-history users. It is
// NEVER presented as the user's own data — the preview frames it as "a glimpse
// of what's ahead" (honesty; Codex). 7 values to match a 7-day window.
export const REPRESENTATIVE_DAY_SCORES: readonly number[] = [42, 48, 55, 61, 70, 78, 86];
// The ring shows "today" = the most recent (last) day, so it must equal the last
// bar. Derive it so the arc and the rightmost bar can never visually disagree.
export const REPRESENTATIVE_SCORE = REPRESENTATIVE_DAY_SCORES[REPRESENTATIVE_DAY_SCORES.length - 1];

// Fewer than this many real daily scores in the window → use the representative
// arc (avoids an all-gray / near-empty preview for brand-new users; Codex).
const MIN_REAL_DAYS = 2;

function validScore(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}

/**
 * Build the shape-only preview from `scoreHistory` over `dayKeys`, which MUST be
 * ordered oldest→newest (so bars read left→right and "current = most recent" is
 * the last index). `lastNDayKeys` returns newest→oldest, so reverse it first.
 * Returns the user's real shape when they have
 * ≥ MIN_REAL_DAYS real daily scores in the window; otherwise the representative
 * arc with `isRepresentative=true`.
 */
export function pickPreviewStats(
  scoreHistory: Record<string, unknown> | null | undefined,
  dayKeys: readonly string[],
): PreviewStats {
  const hist = scoreHistory && typeof scoreHistory === 'object' && !Array.isArray(scoreHistory)
    ? (scoreHistory as Record<string, unknown>)
    : {};

  const real: PreviewDay[] = dayKeys.map((key) => ({ key, score: validScore(hist[key]) }));
  const realCount = real.filter((d) => d.score !== null).length;

  if (realCount >= MIN_REAL_DAYS) {
    // current score = most recent non-null day in the window
    let current = REPRESENTATIVE_SCORE;
    for (let i = real.length - 1; i >= 0; i--) {
      if (real[i].score !== null) { current = real[i].score as number; break; }
    }
    return { dayScores: real, score: current, isRepresentative: false };
  }

  // Representative: map the arc onto the provided keys (fall back to synthetic
  // indices if the window length differs from the arc length).
  const dayScores: PreviewDay[] = REPRESENTATIVE_DAY_SCORES.map((s, i) => ({
    key: dayKeys[i] ?? `rep-${i}`,
    score: s,
  }));
  return { dayScores, score: REPRESENTATIVE_SCORE, isRepresentative: true };
}
