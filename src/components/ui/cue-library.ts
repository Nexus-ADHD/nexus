/**
 * cue-library.ts — NEX-209 (C-6)
 *
 * If-then cue anchoring (implementation intentions — the best-evidenced ADHD
 * initiation booster): a small curated library of trigger cues a habit can be
 * anchored to ("after morning coffee -> meditate"). RN-free so the library + the
 * surfacing gate are unit-testable.
 *
 * Stored in a NEW RecurringRule.cue field (NOT the existing `anchor` field, whose
 * timing-drift leverage machinery would otherwise wake into a "your timing is
 * drifting" verdict, §1.5 Law C). Cues are NEUTRAL fragments — no first person
 * "I" (would read as falsely user-authored) and no second person "you" (§18).
 */

export const HABIT_CUES: readonly string[] = [
  'After morning coffee',
  'After breakfast',
  'After lunch',
  'After dinner',
  'Before bed',
  'Right after waking',
  'When the workday starts',
  'When the workday ends',
  'On the first break',
  'After the school run',
];

/**
 * Surface the cue on Home while the habit is NOT yet started — it is a
 * starter/initiation aid, so it shows until the first rep (completedCount === 0),
 * not until the habit is fully done (which matters for timesPerDay > 1).
 */
export function shouldShowCue(
  cue: string | null | undefined,
  completedCount: number,
): boolean {
  return typeof cue === 'string' && cue.trim().length > 0 && completedCount === 0;
}
