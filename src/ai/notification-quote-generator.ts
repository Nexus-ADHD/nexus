// Generation orchestration for notification quotes. The chat call is INJECTED
// (not imported) so this stays vitest-testable and decoupled from the RN AI
// client. Spec: docs/plans/notification-quotes.md + NEX-277 supersession note.
//
// NEX-277: lines are PERSONALIZED from the reader's mandates and AUTO-SCHEDULE
// once filter-safe (no human gate). Defense in depth: (1) the PROMPT steers the
// model toward present-tense "grounded momentum" and explicitly forbids recall /
// obligation framing, (2) the FILTER drops syntactic + reproach failures into
// nowhere, (3) the curated seed floor + Settings kill switch + per-line tombstone
// are the remaining backstops. Generation never throws.

import { QuotePool, ThrottleOpts, addCandidates, shouldGenerate } from './notification-quote-pool';

export interface GenerateDeps {
  /** Injected chat completion: prompt -> raw model text. May reject. */
  chat: (prompt: string) => Promise<string>;
  nowMs: number;
}

export interface GenerateOpts extends ThrottleOpts {
  /** How many lines to ask for per batch. */
  count: number;
  /** Notification prompts to reject as duplicates. */
  knownPrompts?: string[];
  /** The reader's mandate statements (already capped/sanitized by the caller).
   *  When present, the prompt personalizes lines to these identities. */
  mandates?: string[];
}

/** The voice contract handed to the model — the first line of defense (§0, §18,
 *  §1.5 Law C). `mandates` (if any) personalize the lines to the reader's stated
 *  identity. The recall/obligation bans here mirror the deterministic filter so
 *  the model is steered away from the failures the filter would otherwise drop. */
export function buildQuotePrompt(count: number, mandates: string[] = []): string {
  const clean = mandates.map((m) => (typeof m === 'string' ? m.trim() : '')).filter((m) => m.length > 0);
  const lines = [
    `Write ${count} short lines for a calm, identity-focused habit app's lock-screen notifications.`,
    'Voice: present-tense, declarative, grounded momentum — an energizing forward pull, never hype.',
    'Each line affirms who the reader already is and points to the next move available today.',
  ];
  if (clean.length > 0) {
    lines.push(
      'The reader has stated these identities about themselves:',
      ...clean.map((m) => `- ${m}`),
      'Reflect these back as ALREADY TRUE and available today. Draw on them for specifics, but',
      'rewrite in your own words — never paste a statement verbatim.',
    );
  }
  lines.push(
    'Hard rules:',
    '- No exclamation points. No question marks. No em dashes. No emoji. No quotation marks around the line.',
    '- Never recall a past promise ("you said", "you promised", "you committed").',
    '- Never frame an identity as an obligation, a debt, or something the reader owes or must live up to.',
    '- Never reference streaks, missed days, or anything the reader did or did not do.',
    '- No shame, no pressure, no second-person scolding ("you should", "you need to").',
    '- No author attribution, no AI self-reference.',
    '- Under 100 characters. End on a declarative period.',
    'Return one line per row, no numbering, no bullets.',
  );
  return lines.join('\n');
}

/** Parse raw model text into candidate lines: split rows, strip numbering / bullets / wrapping quotes. */
export function parseQuoteLines(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/\r?\n/)
    .map((l) =>
      l
        .trim()
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '') // leading bullet / "1." / "1)"
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '') // wrapping quotes (straight + curly, double + single)
        .trim(),
    )
    .filter((l) => l.length > 0);
}

/**
 * Generate a batch into the `pending` pool when throttle allows. Never throws:
 * on chat failure (proxy/offline/SIM_BYPASS) the pool is returned with only
 * `lastGenAtMs` advanced, so the caller keeps its existing pool + seed floor (S12).
 * Filter-passing lines land in `pending` via addCandidates; post-NEX-277 those
 * are auto-scheduled (no human gate), with the filter + tombstone as the guards.
 */
export async function generateInto(
  pool: QuotePool,
  deps: GenerateDeps,
  opts: GenerateOpts,
): Promise<QuotePool> {
  if (!shouldGenerate(pool, deps.nowMs, opts, opts.knownPrompts)) return pool;
  let raw: string;
  try {
    raw = await deps.chat(buildQuotePrompt(opts.count, opts.mandates ?? []));
  } catch {
    return { ...pool, lastGenAtMs: deps.nowMs }; // record the attempt; no crash, no change
  }
  const lines = parseQuoteLines(raw);
  return { ...addCandidates(pool, lines, opts.knownPrompts), lastGenAtMs: deps.nowMs };
}
