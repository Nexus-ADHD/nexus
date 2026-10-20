/**
 * Cost bounds for the ai-proxy /chat route (2026-10-18 security fix).
 * ────────────────────────────────────────────────────────────────────
 * The proxy used to forward the client body to the provider unchanged, so a
 * signed-in caller could ask for many completions per call (`n`), an
 * unbounded output length, or a premium model the app never uses, all on our
 * keys. This bounds the three cost levers without touching content:
 *
 *   - `n` is forced to 1 (the app never asks for more than one choice);
 *   - the output cap is clamped to CHAT_MAX_OUTPUT_TOKENS, and set to it when
 *     absent for OpenAI/Kimi (whose default is the model maximum). Anthropic
 *     already defaults to its own 4096 in anthropic-shape.ts, so an absent cap
 *     is left alone there;
 *   - premium-tier model names the app never sends are refused.
 */

export const CHAT_MAX_OUTPUT_TOKENS = 16000;

// Model families the app never requests and that cost many times more per
// token. Anything else (the app's gpt-*, o3/o4-mini, claude-*, kimi-*) passes.
const PREMIUM_MODEL = /(^o1\b|^o1-|-pro\b|-pro-|gpt-4\.5|deep-research|-search-preview)/i;

export type BoundResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

export function boundChatRequest(
  input: Record<string, unknown>,
  isAnthropic: boolean,
): BoundResult {
  const model = typeof input.model === 'string' ? input.model : '';
  if (model && PREMIUM_MODEL.test(model)) return { ok: false, error: 'model_not_allowed' };

  const body: Record<string, unknown> = { ...input };
  if ('n' in body) body.n = 1;

  const cap = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), CHAT_MAX_OUTPUT_TOKENS) : undefined;

  const mct = cap(body.max_completion_tokens);
  const mt = cap(body.max_tokens);
  if ('max_completion_tokens' in body) {
    if (mct === undefined) delete body.max_completion_tokens;
    else body.max_completion_tokens = mct;
  }
  if ('max_tokens' in body) {
    if (mt === undefined) delete body.max_tokens;
    else body.max_tokens = mt;
  }
  if (mct === undefined && mt === undefined && !isAnthropic) {
    body.max_completion_tokens = CHAT_MAX_OUTPUT_TOKENS;
  }
  return { ok: true, body };
}
