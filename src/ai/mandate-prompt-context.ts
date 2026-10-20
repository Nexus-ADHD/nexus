// NEX-307: the one place mandates are turned into prompt text.
//
// `Pillar.notes` is the richest thing a user tells us about a mandate — the
// mandate detail screen asks "Why this matters, what success looks like" and
// offers voice dictation — and until this module existed it reached ZERO
// prompts. Strengthen saw only {id, title, category}; the global AI context
// sent a bare count per category ("BUSINESS: 4. PERSONAL: 3").
//
// This module exists so that every surface that wants mandate context gets the
// same bounded, sanitized shape, instead of each one hand-rolling a join.
//
// ─── Notes are UNTRUSTED, cloud-synced free text ─────────────────────────────
//
// They are user-authored, arbitrarily long, and arrive from cloud sync. Every
// consumer therefore gets them count-capped and length-capped here, never raw.
// Generalizes the pattern already proven in notification-mandate-context.ts.
//
// ─── Deliberately NOT used by notification quotes ────────────────────────────
//
// Notification quotes keep their titles-only context (notification-mandate-
// context.ts) on purpose. Two reasons, both load-bearing:
//
//   1. PRIVACY. Quotes render on the LOCK SCREEN, readable by anyone who
//      glances at the phone without unlocking it. A mandate title is an
//      identity statement the user chose to state; a note is private working
//      material ("why this matters" invites exactly the personal detail you
//      would not want echoed on a lock screen). Piping notes there would be a
//      privacy escalation the user never opted into.
//   2. It avoids a lose-lose cache decision. The quote pool evicts on a mandate
//      hash change (evictForMandateChange). Folding notes into that hash evicts
//      the generated pool on every note edit; leaving them out means lines
//      generated from since-deleted note content keep firing. Not feeding notes
//      to that surface dissolves the dilemma.
//
// So: in-app, user-initiated surfaces get notes. The lock screen does not.

/** A pillar as this module needs to see it. Structurally typed so callers can
 *  pass their own Pillar/MandateRef without importing app-state (this module is
 *  pure and RN-free so it runs in the Node vitest suite). */
export interface MandateForPrompt {
  title?: string;
  notes?: string;
  category?: string;
  completed?: boolean;
}

/** Most mandates fed to a prompt. A user can have 20+; keep prompts bounded. */
export const MAX_MANDATES = 6;
/** Per-mandate title cap (titles are free text). Matches the notification path. */
export const MAX_TITLE_CHARS = 90;
/** Per-mandate note cap. Notes are long-form by design, so this is wider than
 *  the title cap but still bounded: 6 × 240 ≈ 1.4k chars worst case. */
export const MAX_NOTE_CHARS = 240;

/** One mandate, sanitized and capped, ready to render into a prompt. */
export interface PreparedMandate {
  title: string;
  /** Empty string when the user has not written a note. */
  notes: string;
  /** Empty string when uncategorized. */
  category: string;
}

/** Collapse whitespace (notes are multi-line; prompts read better on one line)
 *  and hard-cap length. */
function clean(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/**
 * Sanitize + cap a single note for prompt use.
 *
 * For the single-mandate case (Strengthen builds a prompt about ONE mandate, so
 * it does not need the list formatter). Returns '' for absent/blank notes so
 * callers can `if (why)` and omit the line entirely.
 */
export function capNoteForPrompt(value: unknown, maxChars: number = MAX_NOTE_CHARS): string {
  return clean(value, maxChars);
}

/**
 * Active mandates, sanitized + count-capped, in input order.
 *
 * "Active" mirrors the notification path: a pillar must be non-completed and
 * have a non-empty title. A mandate with no notes is still included — its title
 * is useful context on its own.
 */
export function prepareMandates(
  pillars: readonly MandateForPrompt[] | null | undefined,
  opts: { maxMandates?: number; maxTitleChars?: number; maxNoteChars?: number } = {},
): PreparedMandate[] {
  const maxMandates = opts.maxMandates ?? MAX_MANDATES;
  const maxTitleChars = opts.maxTitleChars ?? MAX_TITLE_CHARS;
  const maxNoteChars = opts.maxNoteChars ?? MAX_NOTE_CHARS;

  return (Array.isArray(pillars) ? pillars : [])
    .filter((p): p is MandateForPrompt => !!p && !p.completed)
    .map((p) => ({
      title: clean(p.title, maxTitleChars),
      notes: clean(p.notes, maxNoteChars),
      category: clean(p.category, 40),
    }))
    .filter((p) => p.title.length > 0)
    .slice(0, maxMandates);
}

/**
 * Render prepared mandates as a prompt block.
 *
 * Shape (one mandate per line, note inline so the model reads them as a pair):
 *   - Be present with my family (PERSONAL) — why: picks up the family thread…
 *   - Build something worth my name (BUSINESS)
 *
 * Returns '' when there is nothing to say, so callers can omit the line
 * entirely rather than emitting an empty header.
 */
export function formatMandatesForPrompt(
  pillars: readonly MandateForPrompt[] | null | undefined,
  opts?: { maxMandates?: number; maxTitleChars?: number; maxNoteChars?: number },
): string {
  return prepareMandates(pillars, opts)
    .map((m) => {
      const cat = m.category ? ` (${m.category})` : '';
      const why = m.notes ? ` — why: ${m.notes}` : '';
      return `- ${m.title}${cat}${why}`;
    })
    .join('\n');
}

// NOTE (NEX-307): a `hasAnyMandateNotes(pillars)` helper was written here and
// then deleted before merge — nothing consumed it. `formatMandatesForPrompt`
// already returns '' when there is nothing to say, and the Strengthen nudge is
// a single-mandate check (`capNoteForPrompt`). Per the NEX-305 lesson, an
// exported helper with no call site reads as wiring that is not happening.

/**
 * NEX-307/#336: resolve a mandate's prompt-and-write fields LIVE from the
 * pillar list, by id.
 *
 * A `MandateRef` handed to a component is an IDENTITY TOKEN, not a data
 * carrier. Two review rounds on #336 proved why, from opposite directions:
 *
 *   1. Putting `notes` on the ref made its object identity change on every
 *      notes blur. The Strengthen fetch closes over that object, so writing a
 *      note silently spent an AI call.
 *   2. Fixing that by narrowing the fetch to the id alone then left the prompt
 *      reading `title`/`category` off the stale closed-over object, so renaming
 *      a mandate kept prompting with the OLD title. The first fix moved the bug
 *      instead of removing it.
 *
 * One rule dissolves both: pass the id, read the fields late. Callers hand in
 * the current pillar array (`useAppState.getState().pillars`) at the moment of
 * use, so a rename or re-category is reflected immediately without any field
 * ever entering fetch identity.
 *
 * `fallback` is returned field-by-field when the pillar cannot be resolved (it
 * was deleted while a sheet was open), so the result degrades to
 * slightly-stale rather than to empty strings.
 *
 * Pure and RN-free on purpose: the component that consumes this cannot be
 * imported by the Node vitest suite, so the logic lives here where it can be
 * tested directly.
 */
export function resolveMandateFields(
  pillars: unknown,
  ref: { id?: string; title?: string; category?: string },
): { title: string; category: string; notes: string } {
  const fallback = {
    title: String(ref?.title ?? ''),
    category: String(ref?.category ?? ''),
    notes: '',
  };
  const id = ref?.id;
  if (!id || !Array.isArray(pillars)) return fallback;

  const found = pillars.find(
    (p: any) => p && p.id !== undefined && p.id !== null && String(p.id) === String(id),
  ) as any;
  if (!found) return fallback;

  // Each field falls back independently: a pillar with a title but no category
  // should still contribute its title, not drop to the whole fallback.
  const title = typeof found.title === 'string' && found.title.length > 0
    ? found.title
    : fallback.title;
  const category = typeof found.category === 'string' && found.category.length > 0
    ? found.category
    : fallback.category;

  return { title, category, notes: capNoteForPrompt(found.notes) };
}
