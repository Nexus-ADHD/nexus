// Pure helpers for the Weekly Debrief chart tier colors + bar heights — the
// single SOURCE OF TRUTH consumed by BOTH Home's chart (home-screen.tsx) and the
// NEX-121 paywall `PaywallContentPreview`/`WeeklyDebriefChart`, so the two
// surfaces can't drift. Pure (no RN) so the logic is unit-testable in the Node
// vitest suite (the RN components aren't importable there). Change a threshold
// here and both surfaces update together.
//
// The two surfaces keep their own (deliberately different) LAYOUTS — Home has
// flex bars + day labels + KPI tiles; the preview is centered bars-only — only
// this tier logic is shared.
import tokens from '@/src/theme/tokens';

/** A day's score, or null for a paused / missing day (rendered as a stub bar). */
export type DayScore = number | null;

/**
 * Bar color by score tier — matches Home:
 *   null → surfaceElevated (gray stub) · ≥80 teal · 50–79 gold · <50 textMuted.
 * No red for a low day (Law C — a quiet day reads quiet, never alarmed).
 */
export function barColorForScore(score: DayScore): string {
  if (score === null || !Number.isFinite(score)) return tokens.color.surfaceElevated;
  if (score >= 80) return tokens.color.teal;
  if (score >= 50) return tokens.color.gold;
  return tokens.color.textMuted;
}

/**
 * Bar height in px for a score, proportional to score/100 over [minHeight, maxHeight].
 * null / non-finite → minHeight (a small stub, matching Home's `Math.max(4, …)`).
 */
export function barHeightForScore(score: DayScore, maxHeight: number, minHeight = 4): number {
  if (score === null || !Number.isFinite(score)) return minHeight;
  const clamped = Math.max(0, Math.min(100, score));
  return Math.max(minHeight, (clamped / 100) * maxHeight);
}

/**
 * Color for a Weekly Debrief KPI tile (Habits / Avg Score / Tasks) by its rate:
 *   ≥70 teal · ≥40 gold · else textMuted (no red — Law C).
 * Note the KPI tiers (70/40) differ from the per-day BAR tiers (80/50) — a KPI is
 * a weekly aggregate, the bar a single day. Matches Home (home-screen.tsx).
 */
export function kpiColorForRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return tokens.color.textMuted; // null = no data / all-paused window
  if (rate >= 70) return tokens.color.teal;
  if (rate >= 40) return tokens.color.gold;
  return tokens.color.textMuted;
}
