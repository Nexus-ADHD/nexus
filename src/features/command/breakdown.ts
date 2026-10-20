// NEX-210 (C-5) — pure, RN-free helpers for "break this into steps".
// Kept out of RN modules so the gate / grain / parse logic is vitest-coverable.
//
// Direction (wiki TIER-13 / Friction Audit): OFFER, never impose; default off;
// gate on size/vagueness (over-breaking a trivial task reads as condescending —
// the named backfire). Goblin-Tools "spiciness" as 2–3 grain chips.

export type BreakdownGrain = 'few' | 'several' | 'fine';

// Target step counts per grain (Goblin's low≈5 / max≈15+ compressed to a calm
// 3 / 5 / 8 so an OS surface doesn't atomize "pick up the sponge").
export const GRAIN: Record<BreakdownGrain, number> = { few: 3, several: 5, fine: 8 };
export const GRAIN_ORDER: BreakdownGrain[] = ['few', 'several', 'fine'];
export const DEFAULT_GRAIN: BreakdownGrain = 'several';

// Hard ceiling on landed steps regardless of grain / AI over-generation.
export const MAX_BREAKDOWN_STEPS = 12;

// Multi-word vagueness verb phrases. DELIBERATELY no bare "plan" ("meal plan",
// "plan B") and no single "and" ("milk and eggs") — those over-fire into the
// condescension backfire. Conservative by design: a false negative (no offer)
// is fine; a false positive is the failure mode.
const VAGUE_PHRASES = [
  'deal with',
  'figure out',
  'sort out',
  'sort through',
  'clean out',
  'clean up',
  'look into',
  'take care of',
  'get started on',
  'go through',
  'work on',
];
// "get … sorted/done/together/organized/set up" wrapping verb. NOTE: "going" is
// deliberately excluded — "get going to the gym" is atomic, not a multi-step job.
const GET_X_DONE = /\bget\b.+\b(sorted|done|together|organized|set up)\b/;

// Long captures are breakable on size alone even without a marker phrase.
const LONG_WORD_COUNT = 9;

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Should the app OFFER to break this capture into steps? Conservative: fires on
 * a multi-word vagueness phrase (regardless of length — "get my taxes sorted" is
 * only 4 words), or on clear size. A short concrete capture ("call mom") matches
 * neither → no offer. Pure — the single gate (the breakdown itself is AI +
 * user-accepted).
 */
export function looksBreakable(title: string | null | undefined): boolean {
  const t = (title ?? '').trim().toLowerCase();
  if (!t) return false;
  // Whole-phrase match (space-padded) so the markers don't leak as substrings:
  // "work on" must NOT fire on "network on", "homework", "firework".
  const padded = ` ${t} `;
  if (VAGUE_PHRASES.some((p) => padded.includes(` ${p} `))) return true;
  if (GET_X_DONE.test(t)) return true;
  if (wordCount(t) >= LONG_WORD_COUNT) return true; // long enough to likely be multi-step
  return false;
}

/**
 * Coerce the AI's step output into a clean list. Accepts a JSON {steps:[]},
 * a bare array, or a numbered/newline list (defensive, like command-parser).
 * Trims, strips leading numbering/bullets, drops blanks/dupes, caps at `max`.
 */
export function parseBreakdownSteps(
  raw: unknown,
  max: number = MAX_BREAKDOWN_STEPS,
): string[] {
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as any).steps)) {
    items = (raw as any).steps;
  } else if (typeof raw === 'string') {
    items = raw.split(/\r?\n/);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (typeof it !== 'string') continue;
    const cleaned = it
      .replace(/^\s*[-*•]\s+/, '') // bullets
      .replace(/^\s*\d+[.)]\s+/, '') // "1. " / "1) "
      .replace(/[!]+$/, '') // §18: no exclamation
      .replace(/\s*[—–]\s*/g, ' - ') // §18: no em/en dash (defensive — AI output lands in a title)
      .trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

export function normalizeGrain(g: unknown): BreakdownGrain {
  return g === 'few' || g === 'several' || g === 'fine' ? g : DEFAULT_GRAIN;
}
