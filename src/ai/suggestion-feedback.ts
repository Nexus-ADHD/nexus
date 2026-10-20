// NEX-308: what the user did with the AI's suggestions.
//
// Until this module, nothing in the app recorded whether a suggestion was taken
// or thrown away. Regenerate existed; learning from the regenerate did not. So
// the recommender could not improve — suggestion #200 was exactly as informed as
// suggestion #1.
//
// This ticket records the signal and NOTHING else. It is deliberately not read
// by any prompt yet (roadmap 4.2 does that, and brings its own formatter with
// it). Shipping the record before the read is the NEX-222 metric-honesty rule:
// a half-wired feedback loop is worse than none.
//
// Pure + RN-free so the whole contract is covered by the Node vitest suite,
// unlike the store and the sheet that call it.

/** What kind of thing was suggested. */
export type SuggestionKind = 'habit' | 'todo';

/**
 * What became of it.
 *  - 'accepted'    — the user tapped ADD.
 *  - 'regenerated' — the user asked for a different set while this item was on
 *                    screen and un-added. An implicit rejection, which is the
 *                    only rejection signal this UI actually produces (there is
 *                    no explicit "no thanks" control).
 */
export type SuggestionOutcome = 'accepted' | 'regenerated';

export interface SuggestionFeedbackEntry {
  kind: SuggestionKind;
  outcome: SuggestionOutcome;
  /** AI-generated free text — capped on write (see MAX_TITLE_CHARS). */
  title: string;
  /** Pillar id the suggestion was generated for. '' when unknown. */
  mandateId: string;
  /** Unix ms. */
  at: number;
}

/**
 * Most entries retained. The log is append-only from the caller's point of view,
 * so it needs a ceiling here or it grows for the life of the install — the
 * NEX-306 `exceptions` lesson (an append-only list nothing prunes eventually
 * becomes a storage/payload problem). Newest are kept; oldest fall off.
 */
export const MAX_FEEDBACK_ENTRIES = 100;

/** Per-title cap. Titles come from the model, so treat them as unbounded text. */
export const MAX_TITLE_CHARS = 80;

function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
}

function isKind(v: unknown): v is SuggestionKind {
  return v === 'habit' || v === 'todo';
}

function isOutcome(v: unknown): v is SuggestionOutcome {
  return v === 'accepted' || v === 'regenerated';
}

/**
 * Coerce a list of unknown/partial rows into valid entries: normalize every
 * field, then drop whatever still cannot satisfy the type.
 *
 * Used for BOTH the persisted log and the incoming outcomes, so a row can never
 * enter the store by a path that skipped normalization.
 */
function normalizeEntries(
  list: unknown,
  now: number,
): SuggestionFeedbackEntry[] {
  return (Array.isArray(list) ? list : [])
    .map((e: any) => ({
      kind: e?.kind,
      outcome: e?.outcome,
      title: cleanTitle(e?.title),
      mandateId: typeof e?.mandateId === 'string' ? e.mandateId : '',
      at: Number.isFinite(e?.at) ? (e.at as number) : now,
    }))
    .filter(
      (e): e is SuggestionFeedbackEntry =>
        isKind(e.kind) && isOutcome(e.outcome) && e.title.length > 0,
    );
}

/**
 * Append outcomes to the log, sanitized and capped.
 *
 * Takes an ARRAY of new outcomes because regenerate rejects a whole shown set at
 * once, and folding them in one pass keeps the write atomic from the store's
 * point of view (one `set`, no read-modify-write race between items).
 *
 * Invalid entries are dropped rather than throwing: this sits on a UI tap path
 * where a malformed record must never break the user's actual action (adding
 * the habit is what matters; recording it is bookkeeping).
 *
 * @param existing current log (tolerates undefined/garbage from a cold store)
 * @param incoming outcomes to append, oldest-first
 * @returns a NEW array, newest-last, length <= MAX_FEEDBACK_ENTRIES
 */
export function recordSuggestionOutcomes(
  existing: unknown,
  incoming: readonly Partial<SuggestionFeedbackEntry>[] | null | undefined,
  now: number = Date.now(),
): SuggestionFeedbackEntry[] {
  // BOTH the already-persisted rows and the incoming ones go through the SAME
  // normalizer. An earlier version only FILTERED the existing rows (kept any row
  // with a valid kind/outcome and a string title), which meant a persisted entry
  // with an overlong or multiline title, or a missing `at`, survived migration
  // still violating SuggestionFeedbackEntry — while this function is exactly
  // what `migrate()` calls to sanitize. Greptile T-Rex reproduced it on #337.
  // Two code paths for one invariant is how that drift happened; there is now
  // one path.
  const base = normalizeEntries(existing, now);
  const added = normalizeEntries(incoming, now);

  const next = added.length === 0 ? base : [...base, ...added];
  // Keep the newest window. (Always returns a fresh array, including on a
  // no-op append — the caller writes it into a zustand `set` which replaces the
  // slice regardless, so trading referential stability for one obvious code
  // path is the right call here.)
  return next.length > MAX_FEEDBACK_ENTRIES ? next.slice(next.length - MAX_FEEDBACK_ENTRIES) : next;
}
