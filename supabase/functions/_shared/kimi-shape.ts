// Kimi (Moonshot AI) provider route for ai-proxy.
//
// Unlike the Anthropic route (anthropic-shape.ts), Kimi needs NO dialect
// translation: https://api.moonshot.ai/v1 is OpenAI Chat Completions
// compatible end to end — same request body, same response body, same
// streaming shape, and JSON mode (`response_format: { type: 'json_object' }`)
// is supported. The request and response both pass through verbatim, exactly
// like the OpenAI route, with three deliberate exceptions:
//
//   1. The token cap. The pre-gpt-5 spelling `max_tokens` is rejected by
//      OpenAI's gpt-5 family (400: "use max_completion_tokens") — that
//      rejection is what put the Strengthen sheet into its deterministic
//      retry loop — and Kimi's own docs use `max_completion_tokens` (it is
//      also what their rate limiter counts up front). The app client now
//      sends `max_completion_tokens` directly; this rename is the
//      belt-and-braces for any caller still sending the old field.
//
//   2. The model alias below (NEX-327). `kimi-k2.5` was retired upstream and
//      every call naming it 404s ("model not found") — verified live
//      2026-08-06: `GET /v1/models` on api.moonshot.ai serves exactly
//      kimi-k2.6, kimi-k3, kimi-k2.7-code, kimi-k2.7-code-highspeed.
//      ALREADY-INSTALLED app builds still send `kimi-k2.5`, so the remap
//      happens here, server-side, where a redeploy fixes them without an
//      app release.
//
//   3. `thinking` is injected as disabled by default (NEX-327). This app
//      never surfaces reasoning, and with thinking left enabled an 800-token
//      cap is consumed by reasoning_content, returning truncated JSON
//      (finish_reason=length) — verified live 2026-08-06 with the exact
//      Strengthen payload: 14.8s and unparseable JSON vs. complete JSON in
//      3.9s with thinking disabled. A caller-provided `thinking` always wins.
//
// Pure and dependency-free so `deno test` covers it without a network call,
// following the anthropic-shape.ts precedent.

export const MOONSHOT_ENDPOINT = 'https://api.moonshot.ai/v1/chat/completions';

/**
 * Retired upstream -> currently served replacement. The source of truth is
 * `GET /v1/models` on api.moonshot.ai; as of 2026-08-06 it serves only
 * kimi-k2.6 / kimi-k3 / kimi-k2.7-code / kimi-k2.7-code-highspeed. This map
 * exists so already-installed app builds that still send the retired id are
 * fixed by a proxy redeploy, without an app release (NEX-327).
 */
const MODEL_ALIASES: Record<string, string> = {
  'kimi-k2.5': 'kimi-k2.6',
};

/** Models routed to Kimi. Everything else goes to OpenAI (or Anthropic). */
export function isKimiModel(model: unknown): boolean {
  return typeof model === 'string' && /^kimi-/i.test(model);
}

/**
 * Chat Completions body -> Kimi body: verbatim, except three things —
 * `body.model` is rewritten through MODEL_ALIASES (retired ids 404 upstream),
 * `thinking` defaults to disabled (see the file header — enabled thinking
 * burns a capped token budget on reasoning_content and returns truncated
 * JSON; verified live 2026-08-06; a caller-provided `thinking` always wins),
 * and a legacy `max_tokens` is renamed to `max_completion_tokens` (an
 * explicit `max_completion_tokens` always wins).
 */
export function toKimiRequest(body: any): any {
  if (!body || typeof body !== 'object') return body;
  const { max_tokens, model, ...rest } = body;
  if (typeof model === 'string') {
    const alias = MODEL_ALIASES[model.toLowerCase()];
    rest.model = alias ?? model;
  } else if (model !== undefined) {
    rest.model = model;
  }
  // This app never surfaces reasoning; a caller that WANTS thinking must say so.
  if (rest.thinking === undefined) {
    rest.thinking = { type: 'disabled' };
  }
  if (
    typeof max_tokens === 'number' &&
    Number.isFinite(max_tokens) &&
    max_tokens > 0 &&
    rest.max_completion_tokens === undefined
  ) {
    return { ...rest, max_completion_tokens: Math.floor(max_tokens) };
  }
  return rest;
}
