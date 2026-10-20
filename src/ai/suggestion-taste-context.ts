// NEX-310 (roadmap 4.2): turn the acceptance log into prompt text.
//
// NEX-308 started recording what the user does with each AI suggestion —
// added it, or regenerated the set away. Nothing read that log, so the
// recommender could not improve: suggestion #200 was exactly as informed as
// suggestion #1. That gap is the difference between an app with AI in it and
// an app that gets smarter.
//
// This module is the read side. It is deliberately a SEPARATE ticket from the
// write side (NEX-222 metric-honesty rule): a half-wired feedback loop is worse
// than none, because it looks like learning without being learning.
//
// ─── Why a digest and not the log ────────────────────────────────────────────
//
// Pasting 100 rejected titles into a prompt teaches a model almost nothing
// except to avoid 100 specific strings, while spending a large share of the
// context window on the least useful text in the app. What actually steers a
// recommender is a short, recency-weighted read of TASTE: the shape of what
// this person takes, and the shape of what they push away.
//
// So the digest is capped hard, deduped, newest-first, and scoped to the
// mandate at hand before it falls back to global taste.
//
// ─── Voice (§1.5 Law C) ──────────────────────────────────────────────────────
//
// The digest describes PREFERENCES, never the person. It never counts what the
// user failed to do, never frames a regenerate as a failure, and never reaches
// the user's eyes at all — it is model-facing steer, and it is written so that
// if it ever did surface it would still not shame anyone.
//
// Pure and RN-free so the whole contract is covered by the Node vitest suite.

import type { SuggestionFeedbackEntry, SuggestionKind } from './suggestion-feedback';

/**
 * Most titles shown per bucket (accepted / declined, per kind).
 *
 * Four is enough to establish a pattern and small enough that the digest stays
 * a hint rather than a second prompt. With 2 kinds x 2 outcomes the worst case
 * is 16 titles.
 */
export const MAX_TITLES_PER_BUCKET = 4;

/** Per-title cap inside the digest. Titles are model output; treat as unbounded. */
export const MAX_DIGEST_TITLE_CHARS = 60;

/**
 * Newest entries considered. The stored log holds up to 100; taste from months
 * ago is weak evidence and would dilute a recent, clearer signal.
 */
export const MAX_ENTRIES_CONSIDERED = 40;

/**
 * Minimum entries before the digest says anything at all.
 *
 * One accepted habit is not a preference, it is an accident. Speaking with
 * confidence off a single data point produces worse suggestions than staying
 * quiet, and the empty case must be indistinguishable from today's behavior.
 */
export const MIN_ENTRIES_FOR_SIGNAL = 3;

function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_DIGEST_TITLE_CHARS);
}

function isEntry(e: any): e is SuggestionFeedbackEntry {
  return (
    !!e &&
    (e.kind === 'habit' || e.kind === 'todo') &&
    (e.outcome === 'accepted' || e.outcome === 'regenerated') &&
    typeof e.title === 'string'
  );
}

export interface TasteBucket {
  kind: SuggestionKind;
  accepted: string[];
  declined: string[];
}

export interface PreparedTaste {
  buckets: TasteBucket[];
  /** How many entries backed this digest, after scoping and capping. */
  considered: number;
  /** True when the digest was built from this mandate's own history. */
  mandateScoped: boolean;
}

/**
 * Select, scope, order and cap the raw log into per-kind taste buckets.
 *
 * Scoping: if this mandate has enough of its own history, use only that — what
 * a person wants for "I am someone who trains" is not what they want for "I am
 * someone who ships." Otherwise fall back to the whole log, because a weak
 * global signal still beats no signal.
 *
 * @param log      raw persisted log (tolerates undefined/garbage)
 * @param mandateId scope preference; '' or undefined means global only
 */
export function prepareTaste(log: unknown, mandateId?: string): PreparedTaste {
  const all = (Array.isArray(log) ? log : []).filter(isEntry);

  // Newest first. `at` is stamped on write; treat a missing/bad one as oldest
  // so a corrupted row can never crowd out real recent signal.
  const byRecency = [...all].sort((a, b) => {
    const av = Number.isFinite(a.at) ? a.at : -Infinity;
    const bv = Number.isFinite(b.at) ? b.at : -Infinity;
    return bv - av;
  });

  const scoped = mandateId
    ? byRecency.filter((e) => String(e.mandateId ?? '') === String(mandateId))
    : [];
  const mandateScoped = scoped.length >= MIN_ENTRIES_FOR_SIGNAL;
  const source = (mandateScoped ? scoped : byRecency).slice(0, MAX_ENTRIES_CONSIDERED);

  const buckets: TasteBucket[] = [];
  for (const kind of ['habit', 'todo'] as SuggestionKind[]) {
    const forKind = source.filter((e) => e.kind === kind);
    if (forKind.length === 0) continue;

    const take = (outcome: SuggestionFeedbackEntry['outcome']) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const e of forKind) {
        if (e.outcome !== outcome) continue;
        const t = cleanTitle(e.title);
        if (!t) continue;
        // Dedupe case-insensitively: the same suggestion regenerated away three
        // times is one preference, not three.
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
        if (out.length >= MAX_TITLES_PER_BUCKET) break;
      }
      return out;
    };

    const accepted = take('accepted');
    const declined = take('regenerated');
    if (accepted.length === 0 && declined.length === 0) continue;
    buckets.push({ kind, accepted, declined });
  }

  return { buckets, considered: source.length, mandateScoped };
}

/**
 * Render the digest as a prompt block, or `null` when there is not enough
 * signal to say anything honest.
 *
 * Returning null rather than an empty string is deliberate: the caller omits
 * the block entirely, so a user with no history gets a prompt byte-identical
 * to the one before this feature existed. A "(no history)" line would be worse
 * than silence — it spends tokens to tell the model nothing.
 */
export function formatTasteForPrompt(log: unknown, mandateId?: string): string | null {
  const { buckets, considered, mandateScoped } = prepareTaste(log, mandateId);
  if (considered < MIN_ENTRIES_FOR_SIGNAL || buckets.length === 0) return null;

  // The header must not promise more than the buckets deliver. A user who has
  // only ever added suggestions has no "passed on" signal, and claiming one
  // invites the model to invent an aversion out of nothing.
  const hasDeclined = buckets.some((b) => b.declined.length > 0);
  const hasAccepted = buckets.some((b) => b.accepted.length > 0);
  const what = hasAccepted && hasDeclined
    ? 'has taken and passed on'
    : hasAccepted
      ? 'has taken'
      : 'has passed on';
  const scope = mandateScoped ? 'for THIS mandate' : 'across their mandates';

  const lines: string[] = [`What this person ${what} ${scope}:`];

  const noun = (k: SuggestionKind) => (k === 'habit' ? 'Habits' : 'To-dos');
  for (const b of buckets) {
    if (b.accepted.length > 0) {
      lines.push(`- ${noun(b.kind)} they added: ${b.accepted.join(' · ')}`);
    }
    if (b.declined.length > 0) {
      lines.push(`- ${noun(b.kind)} they passed on: ${b.declined.join(' · ')}`);
    }
  }

  // The instruction matters as much as the data. Without it a model tends to
  // either echo the accepted titles back (duplicates the user already has) or
  // treat a passed-on title as forbidden vocabulary rather than a hint about
  // specificity, framing and scale.
  lines.push(
    'Read this as a signal about the STYLE and SCALE they prefer, not a list to copy or avoid. Do not re-suggest anything they already added. Match the register of what they took.',
  );

  return lines.join('\n');
}
