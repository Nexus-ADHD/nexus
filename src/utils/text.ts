/**
 * Shared text-normalization for habit-title comparisons and other
 * key-derivation paths. Folds whitespace, case, and Unicode form so
 * values entered or imported across versions still match.
 *
 * NFC handles the case where two strings look identical but use
 * different combining-character forms (precomposed vs decomposed
 * diacritics, common in iOS dictation output and pasted content).
 */
export function normalize(s: string | null | undefined): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .normalize('NFC');
}

/**
 * Strip pictographic emoji + variation-selector / zero-width joiner
 * residue from a display string. Storage keeps the emoji; this is for
 * render-time scrubbing so existing habits with "Read Mantra 🕉️" or
 * "Clean eating 🥗" render as plain text in v3 UIs.
 */
// Extended_Pictographic covers most emoji, but NOT regional-indicator
// flags (🇺🇸 = two regional indicators) or keycap sequences (1️⃣ = digit +
// FE0F + 20E3). Strip those too so emoji-only titles fully scrub.
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/gu;
export function stripEmoji(s: string): string {
  return String(s ?? '')
    .replace(EMOJI_RE, '')
    // variation selector (FE0F), ZWJ, and the combining enclosing keycap (20E3)
    .replace(/[️‍⃣]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
