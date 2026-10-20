/**
 * structured-output.ts — pure helpers for the command-router Structured-Outputs
 * decision + the fail-open path (NEX-317). RN-free, vitest-coverable.
 *
 * The command call prefers strict `json_schema` (constrained decoding) but MUST
 * degrade safely:
 *   - to `json_object` when the model is not OpenAI-routable — the proxy's Claude
 *     route drops `response_format` entirely, so strict schema is OpenAI-only;
 *   - to `json_object` when OpenAI rejects the strict schema with a 400 — a
 *     malformed schema would otherwise dead-end EVERY AI-routed capture, so the
 *     call falls open to the previously-working JSON mode rather than failing.
 */

import { isOpenAIRoutable } from '../../ai/models';

export type CommandResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> };
    };

/**
 * The response_format to use for a given router model: strict Structured Outputs
 * for an OpenAI-routable model, else legacy JSON mode (the Anthropic proxy route
 * drops response_format, so strict schema there would be a silent no-op at best).
 */
export function buildCommandResponseFormat(
  model: string,
  schema: { name: string; strict?: boolean; schema: Record<string, unknown> },
): CommandResponseFormat {
  return isOpenAIRoutable(model)
    ? { type: 'json_schema', json_schema: schema }
    : { type: 'json_object' };
}

/**
 * True when an error thrown by `chatCompletion` is an OpenAI **schema-validation
 * 400** — the signal to retry the same call with `json_object`. `chatCompletion`
 * throws `AI request failed (400): <body>`; OpenAI's body for a bad strict schema
 * names `response_format` / `schema` / "json_schema". Scoped to 400 so a 401/5xx
 * (auth / outage) does NOT trigger a pointless schema fallback.
 */
export function isSchemaValidation400(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (!/AI request failed \(400/.test(msg)) return false;
  return /response_format|json_schema|schema/i.test(msg);
}

/**
 * The budget to hand the json_object fallback so the retry stays inside the
 * ORIGINAL command deadline — or null when too little is left to retry safely.
 *
 * `chatCompletion` floors its network phase at `minMs` (MIN_FETCH_BUDGET_MS), so
 * passing a remainder below that would still run for ~`minMs` and overshoot the
 * deadline (Greptile NEX-317). When the strict attempt has already spent the
 * budget down to less than the floor, return null and let the caller surface the
 * low tier instead of firing a retry that blows past the deadline (and holds the
 * orb tap guard).
 */
export function fallbackBudgetMs(elapsedMs: number, totalMs: number, minMs: number): number | null {
  const remaining = totalMs - elapsedMs;
  return remaining >= minMs ? remaining : null;
}
