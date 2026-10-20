// NEX-277: derive the mandate context for personalized notification quotes.
// Pure module (no RN imports) so capping + hashing are vitest-testable.
//
// The caller passes the user's pillars (mandates). We take ACTIVE pillar titles
// only, cap the count + length (the prompt must stay bounded; mandate titles are
// untrusted free text), and compute an order-sensitive hash. When the hash
// changes the pool evicts stale personalized lines (see evictForMandateChange).

export interface MandateLike {
  title?: string;
  completed?: boolean;
}

/** Most mandates fed to the prompt (a user can have 20+; keep the prompt bounded). */
export const MAX_MANDATES = 6;
/** Per-mandate character cap (titles are free text). */
export const MAX_MANDATE_CHARS = 90;

/** djb2 over order-sensitive content -> short base36 hash. Stable for [].
 *  Each item is length-prefixed (`len:title` joined on `|`) so two different
 *  splits like ["ab","c"] and ["a","bc"] can never hash the same, using only
 *  plain ASCII (no separator char that could collide with title text). */
function hashStrings(xs: string[]): string {
  const s = xs.map((x) => `${x.length}:${x}`).join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Active pillar titles (trimmed, length-capped, count-capped) + a hash of that
 * exact set. Empty/garbage input -> { mandates: [], hash: <hash of []> }.
 */
export function mandateContext(pillars: readonly MandateLike[] | null | undefined): {
  mandates: string[];
  hash: string;
} {
  const mandates = (Array.isArray(pillars) ? pillars : [])
    .filter(
      (p): p is MandateLike =>
        !!p && !p.completed && typeof p.title === 'string' && p.title.trim().length > 0,
    )
    .map((p) => (p.title as string).trim().slice(0, MAX_MANDATE_CHARS))
    .slice(0, MAX_MANDATES);
  return { mandates, hash: hashStrings(mandates) };
}
