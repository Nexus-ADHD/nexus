// Deterministic Law-C / §18 pre-screen for notification-quote candidates.
//
// NEX-277: AI lines now AUTO-SCHEDULE once they pass this filter — the owner
// removed the human approval gate. That makes this the SOLE deterministic
// safety guard before a personalized line reaches the lock screen, so the
// reproach/obligation bans below are deliberately broad (recall framing,
// accountability/scoreboard language, `?` anywhere). It still cannot prove a
// line is on-voice; the remaining backstops are the tightly-constrained
// generation prompt, the curated seed floor, the Settings kill switch, and the
// per-line tombstone (see docs/plans/notification-quotes.md, §1.5 Law C/E).
// Pure module, no React Native imports, so it is vitest-testable.

/** Max length of a single quote. Bumped 80→100 for the NEX-277 one-line quote format
 *  (the prompt no longer prefixes the body, freeing room). The composed-body cap is
 *  enforced separately at compose time; 100 still renders without truncating its
 *  declarative landing on small (SE-class) lock screens. */
export const MAX_QUOTE_LEN = 100;
/** Below this a "quote" is too terse to read as a line. */
export const MIN_QUOTE_LEN = 8;

// Non-ASCII characters we explicitly allow: curly apostrophes/single quotes (for
// contractions like "don’t") + ellipsis. Curly DOUBLE quotes “ ” are NOT allowed —
// they're quote marks, which the voice forbids. Anything else outside printable
// ASCII is rejected — which also catches emoji (S3) and non-English output (S21).
const ALLOWED_NON_ASCII = '‘’…'; // ‘ ’ …
// Em dash (—) and en dash (–) are banned outright (§18.1).
const DASH_RE = /[—–]/;
// A spaced hyphen reads as an attribution / aside ("line - Author"); reject it.
const SPACED_HYPHEN_RE = / - /;

// Shame / absence-counting / second-person scolding / AI self-reference /
// attribution. Case-insensitive. (§1.5 Law C + §18.1.)
const BANNED_PATTERNS: RegExp[] = [
  /\byou\s+haven'?t\b/i,
  /\byou\s+missed\b/i,
  /\byou\s+failed\b/i,
  /\byou\s+forgot\b/i,
  /\byou\s+need\s+to\b/i,
  /\byou\s+should\b/i,
  /\byou\s+must\b/i,
  /\bdon'?t\s+break\b/i,
  /\bkeep\s+your\s+streak\b/i,
  /\b\d+\s+days?\s+(gone|missed|lost)\b/i,
  /\bgone\s+for\s+\d+\s+days?\b/i,
  /\bbehind\s+again\b/i,
  /\banother\s+day\s+(lost|gone|wasted)\b/i,
  /\bfailing\b/i,
  /\bprove\s+yourself\b/i,
  /\bgiv(?:e|ing)\s+up\b/i, // "give up" and "giving up"
  /\byou\s+always\b/i,
  /\byou\s+keep\b/i,
  /\blet(ting)?\s+(ourselves|yourself|yourselves)\s+down\b/i,
  // NEX-277 — recall framing presupposes a past commitment, which against a rough
  // week reads as counting an absence (Law C). A personalized line must AFFIRM the
  // identity as already true, never recall a promise. ("You said you are someone
  // who ships before noon" → banned.)
  /\byou\s+(said|told|promised|committed|vowed|swore)\b/i,
  // NEX-277 — obligation / accountability / scoreboard framing. A mandate is
  // identity, never a debt owed or a task to discharge ("mandate-as-todo").
  /\bsupposed\s+to\b/i,
  /\blive\s+up\s+to\b/i,
  /\bkeep\s+your\s+word\b/i,
  /\bfollow\s+through\b/i,
  /\byou\s+owe\b/i,
  /\bget\s+back\s+on\s+track\b/i,
  /\bas\s+an\s+ai\b/i,
  /\bi\s+am\s+an?\s+ai\b/i,
  /\blanguage\s+model\b/i,
  // Dash attribution ("— Anonymous", "-- Seneca"). A bare "by X" is intentionally
  // NOT matched (it would reject on-voice "by Sunday" etc.); the curated seed floor
  // and the tight generation prompt cover that residual case.
  /(^|\s)(—|--)\s*[A-Za-z]/,
  /\banonymous\b/i,
];

// Endings that aren't declarative (§18.2: declarative endings that land with weight).
const NON_DECLARATIVE_END_RE = /[?!]\s*$/;
const TRAILING_CONJUNCTION_RE = /\b(and|but|or|so|because|the|a|to|of|with|for)\.?\s*$/i;

/** Strip the allowed-non-ASCII chars, then check whether anything non-ASCII remains. */
function hasDisallowedNonAscii(s: string): boolean {
  let stripped = s;
  for (const ch of ALLOWED_NON_ASCII) stripped = stripped.split(ch).join('');
  return /[^\x20-\x7E]/.test(stripped);
}

/**
 * True iff `raw` is safe to surface as a notification quote on the syntactic
 * axes a deterministic check can decide. A `false` here means "never show";
 * a `true` means "safe enough to put in front of a human reviewer" — NOT
 * "approved to ship". `knownPrompts` are the app's notification prompt strings,
 * rejected so a quote can't duplicate the line it sits under (S21).
 */
export function isNotificationQuoteSafe(raw: unknown, knownPrompts: string[] = []): boolean {
  if (typeof raw !== 'string') return false;
  const line = raw.trim();
  if (line.length < MIN_QUOTE_LEN || line.length > MAX_QUOTE_LEN) return false;

  if (DASH_RE.test(line)) return false;          // em / en dash
  if (SPACED_HYPHEN_RE.test(line)) return false; // attribution hyphen
  if (line.includes('!')) return false;          // exclamation
  if (line.includes('?')) return false;          // NEX-277: question ANYWHERE — a personalized line
                                                 // must land as a statement, never interrogate the reader
  if (line.includes('"')) return false;          // straight double-quote mark (curly “ ” via non-ASCII)
  if (hasDisallowedNonAscii(line)) return false; // emoji / non-English / curly double quotes

  if (NON_DECLARATIVE_END_RE.test(line)) return false;   // ends with ? or !
  if (TRAILING_CONJUNCTION_RE.test(line)) return false;  // dangling ending

  for (const re of BANNED_PATTERNS) if (re.test(line)) return false;

  // No duplicating the prompt the quote sits beneath. Normalize away trailing
  // terminal punctuation (. ? !) on both sides so "a win." matches "a win?".
  const stripEnd = (s: string) => s.toLowerCase().trim().replace(/[\s.?!]+$/g, '');
  const norm = stripEnd(line);
  for (const p of knownPrompts) {
    if (typeof p === 'string' && norm === stripEnd(p)) return false;
  }
  return true;
}
