import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY_TIPS parity gate (autonomous-harness CI net)
//
// WEEKLY_TIPS is the rotating weekly-email copy. It exists in TWO places that
// must stay in lockstep, because the Deno edge bundle can't import RN-coupled
// app source (see the comment in supabase/functions/_shared/weekly-digest.ts):
//
//   1. src/ai/prompts.js                                  — canonical (app)
//   2. supabase/functions/_shared/weekly-digest.ts        — inlined duplicate (edge)
//
// Neither file is covered by `tsc --noEmit`: prompts.js is plain .js (allowJs is
// off) and the supabase/ tree is excluded in tsconfig.json. So the *only*
// mechanical guard against the two copies drifting is this test. Track-A
// auto-eligible edits to either copy are unsafe without it.
//
// IMPORTANT — compare DECODED VALUES, not raw source bytes. The two files encode
// apostrophes differently (prompts.js escapes them: "it\'s"; weekly-digest.ts
// uses bare: "it's"). Both decode to the same string, so a byte comparison would
// be a false failure. We extract each double-quoted literal and decode JS string
// escapes before comparing.
//
// Scope note: this test asserts STRUCTURAL parity only (same count, same order,
// identical decoded content + the rotation contract). It deliberately does NOT
// assert the §18.1 brand-voice rules (no em dash / no exclamation point) yet —
// Tip #1 currently contains an em dash, so adding that assertion here would make
// CI red before NEX-101 lands. NEX-101 (the brand-voice rewrite) is the ticket
// that fixes the copy AND adds the voice assertions below.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const PROMPTS_JS = path.resolve(ROOT, 'src/ai/prompts.js');
const WEEKLY_DIGEST_TS = path.resolve(
  ROOT,
  'supabase/functions/_shared/weekly-digest.ts',
);

const ROTATION_LENGTH = 7; // weekNum % WEEKLY_TIPS.length — length AND order are load-bearing.

/**
 * Decode a single JS string literal (single-, double-, or backtick-quoted) to its
 * runtime value, without eval. Normalizes so we can lean on JSON.parse:
 *   - escaped same-quote chars (\' inside '…', \` inside `…`) → bare char
 *   - bare double-quotes → escaped, so the JSON wrapper stays valid
 * Other escapes present in this copy (\", \\) are already JSON-legal.
 */
function decodeLiteral(literal: string): string {
  const quote = literal[0];
  let inner = literal.slice(1, -1);
  if (quote === '"') {
    inner = inner.replace(/\\'/g, "'"); // \' is valid JS, invalid JSON
  } else {
    // ' or ` : unescape its own quote, then escape bare double-quotes for JSON.
    inner = inner.replace(new RegExp('\\\\' + quote, 'g'), quote);
    inner = inner.replace(/(?<!\\)"/g, '\\"');
  }
  return JSON.parse(`"${inner}"`) as string;
}

/**
 * Pull the `WEEKLY_TIPS = [ ... ]` array literal out of a source file and return
 * the decoded string values. Works for both the exported (.js) and the local
 * `const` (.ts) declarations.
 *
 * Robustness (per code review): anchor the array capture on the closing `];` so a
 * `]` inside a tip can't truncate it; match all three quote styles so a single-
 * quoted or template-literal rewrite isn't silently dropped; and throw if the
 * literal count isn't the rotation length, so a malformed/partial extraction fails
 * LOUD instead of yielding a short array that could coincidentally compare equal.
 */
function extractWeeklyTips(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  const arrayMatch = source.match(/WEEKLY_TIPS\s*=\s*\[([\s\S]*?)\];/);
  if (!arrayMatch) {
    throw new Error(`Could not find a WEEKLY_TIPS = [...]; literal in ${filePath}`);
  }

  const body = arrayMatch[1];
  const literalMatches =
    body.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];

  if (literalMatches.length !== ROTATION_LENGTH) {
    throw new Error(
      `Expected ${ROTATION_LENGTH} tip literals in ${filePath}, extracted ${literalMatches.length}. ` +
        `The array shape changed or extraction failed — fix this before trusting the parity gate.`,
    );
  }

  return literalMatches.map(decodeLiteral);
}

describe('WEEKLY_TIPS parity (app ↔ edge)', () => {
  const appTips = extractWeeklyTips(PROMPTS_JS);
  const edgeTips = extractWeeklyTips(WEEKLY_DIGEST_TS);

  it('the canonical app copy has exactly the rotation length', () => {
    expect(appTips).toHaveLength(ROTATION_LENGTH);
  });

  it('the inlined edge copy has exactly the rotation length', () => {
    expect(edgeTips).toHaveLength(ROTATION_LENGTH);
  });

  it('both copies are identical in decoded content and order', () => {
    // deepEqual checks order too — reordering one copy fails here, which is
    // correct: weekNum % length means order is part of the contract.
    expect(edgeTips).toEqual(appTips);
  });
});
