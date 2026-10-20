/**
 * mandate-echo.ts — NEX-202 (A-1 / M9)
 *
 * Resolves the one-line mandate echo that rides beneath a habit on Home
 * ("You said this matters: '<mandate>'."). RN-free so the Node vitest suite
 * covers it directly.
 *
 * The echo is gated on a USER-CONFIRMED link only: `rule.mandateEchoPillarId`
 * is set exclusively by an explicit tap in HabitEditView, never auto-sourced
 * from the AI-tainted goalHabitMap. The stale guard (pillar must still exist
 * with a non-blank title) means a deleted/blank mandate yields null = silence —
 * "a stale mandate misquotes the user, worse than silence."
 *
 * Reads ONLY the rule field + pillars — never habitLog / completion — so the
 * echo is present on a low/return day regardless of whether the habit is done.
 */

interface EchoRule {
  mandateEchoPillarId?: string | null;
}

interface EchoPillar {
  id: string;
  title?: string | null;
}

export interface MandateEcho {
  pillarId: string;
  /** Whitespace-collapsed mandate text for a clean single-line echo. */
  text: string;
}

/** Collapse internal whitespace/newlines so a multi-line mandate reads as one line. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function resolveMandateEcho(
  rule: EchoRule | null | undefined,
  pillars: readonly EchoPillar[] | null | undefined,
): MandateEcho | null {
  const pillarId = rule?.mandateEchoPillarId;
  if (!pillarId || typeof pillarId !== 'string') return null;
  if (!Array.isArray(pillars)) return null;

  const pillar = pillars.find((p) => p?.id === pillarId);
  if (!pillar) return null; // mandate deleted → silence

  const text = collapseWhitespace(String(pillar.title ?? ''));
  if (text.length === 0) return null; // blank mandate → silence

  return { pillarId, text };
}
