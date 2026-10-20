// NEX-311 (roadmap 1.4 Option A): the Anthropic provider route for ai-proxy.
//
// Background, because this file exists to close a real trap. `src/ai/models.js`
// read for months as an 8-tier routing table with Claude tiers behind an
// `enableClaude` flag. There was no Anthropic route in the proxy at all — the
// chat handler hardcodes `fetch('https://api.openai.com/v1/chat/completions')`.
// Flipping that flag would have sent `model: "claude-opus-4-5"` to OpenAI and
// 400'd every AI feature in the app at once. NEX-305 made the table honest by
// pointing every tier at a real OpenAI model. This module makes the *other*
// half true: an actual provider route, so a Claude tier can be chosen
// deliberately rather than aspirationally.
//
// ─── The contract ────────────────────────────────────────────────────────────
//
// The iOS client speaks ONE dialect: OpenAI Chat Completions. `ai-client.ts`
// reads `data.choices[0].message.content` and nothing else. So translation
// happens HERE, at the proxy, in both directions:
//
//     client (Chat Completions)  ->  toAnthropicRequest   ->  Anthropic Messages
//     client (Chat Completions)  <-  toChatCompletions    <-  Anthropic Messages
//
// The client stays completely unaware of the provider. That is the whole point:
// a provider swap must never become a client migration.
//
// Pure and dependency-free so `deno test` covers every shape edge without a
// network call, following the `weekly-broadcast-shared.test.ts` precedent.

/** Anthropic's Messages API requires an explicit version header. */
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/**
 * Anthropic REQUIRES `max_tokens`; OpenAI treats it as optional and defaults to
 * "until the model stops." A request translated without one is rejected
 * outright, so an omitted value must become a real number here rather than
 * being passed through as undefined.
 *
 * 4096 is chosen to cover this app's longest generation (a deep/quarterly
 * review) with headroom, while still bounding a runaway completion.
 */
export const DEFAULT_MAX_TOKENS = 4096;

/** Models routed to Anthropic. Everything else goes to OpenAI. */
export function isAnthropicModel(model: unknown): boolean {
  return typeof model === 'string' && /^claude-/i.test(model);
}

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: { role: 'user' | 'assistant'; content: string }[];
  system?: string;
  temperature?: number;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  // OpenAI also permits an array of content parts. Keep only text parts; this
  // app never sends images on the chat route, but tolerating the shape costs
  // one line and avoids a silent empty message if that ever changes.
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Chat Completions request -> Anthropic Messages request.
 *
 * Four differences between the dialects, each of which silently breaks the
 * call if unhandled:
 *
 *  1. **System is not a message.** OpenAI carries it as `role: 'system'` in the
 *     array; Anthropic takes a top-level `system` string. Left in the array it
 *     is rejected as an invalid role. Multiple system messages are joined in
 *     order, since this app builds prompts by concatenation.
 *  2. **`max_tokens` is required** (see DEFAULT_MAX_TOKENS).
 *  3. **Messages must alternate and start with `user`.** Anthropic rejects two
 *     consecutive same-role turns; OpenAI does not care. Consecutive turns are
 *     merged, and a leading assistant turn is dropped rather than sent.
 *  4. **`response_format` has no equivalent.** OpenAI's JSON mode is silently
 *     dropped; every prompt in this app already ends with "Return ONLY valid
 *     JSON, no markdown fencing," which is how the OpenAI path gets JSON today
 *     anyway (it does not set response_format either).
 */
export function toAnthropicRequest(body: any): AnthropicRequest {
  const raw: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];

  const systemParts: string[] = [];
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];

  for (const m of raw) {
    const content = textOf(m?.content);
    if (m?.role === 'system') {
      if (content) systemParts.push(content);
      continue;
    }
    if (!content) continue; // Anthropic rejects empty content blocks
    const role: 'user' | 'assistant' = m?.role === 'assistant' ? 'assistant' : 'user';
    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) {
      // Merge rather than send two same-role turns, which Anthropic rejects.
      prev.content = `${prev.content}\n\n${content}`;
    } else {
      turns.push({ role, content });
    }
  }

  // A conversation may not open on an assistant turn.
  while (turns.length > 0 && turns[0].role === 'assistant') turns.shift();

  // The client sends `max_completion_tokens` (the only spelling the gpt-5
  // family and Kimi accept); the legacy `max_tokens` is honored for any
  // caller still sending it.
  const requested = body?.max_completion_tokens ?? body?.max_tokens;
  const maxTokens = Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : DEFAULT_MAX_TOKENS;

  const out: AnthropicRequest = {
    model: String(body?.model ?? ''),
    max_tokens: maxTokens,
    messages: turns,
  };
  const system = systemParts.join('\n\n').trim();
  if (system) out.system = system;
  if (Number.isFinite(body?.temperature)) out.temperature = body.temperature;
  return out;
}

/**
 * Anthropic Messages response -> Chat Completions response.
 *
 * The client reads `choices[0].message.content`, and the proxy's own metrics
 * step reads `usage.prompt_tokens` / `completion_tokens` / `total_tokens` off
 * the returned body. Both must be present or the call looks empty and the
 * Braintrust span loses its token metrics — so `usage` is translated too, not
 * just the text.
 *
 * `stop_reason` maps to `finish_reason` because `max_tokens` truncation is the
 * one case a caller can act on, and it would otherwise be invisible.
 */
export function toChatCompletions(anthropic: any, requestedModel: string): any {
  const blocks = Array.isArray(anthropic?.content) ? anthropic.content : [];
  const content = blocks
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('');

  const inTok = Number(anthropic?.usage?.input_tokens);
  const outTok = Number(anthropic?.usage?.output_tokens);
  const prompt_tokens = Number.isFinite(inTok) ? inTok : undefined;
  const completion_tokens = Number.isFinite(outTok) ? outTok : undefined;

  const stop = anthropic?.stop_reason;
  const finish_reason = stop === 'max_tokens' ? 'length' : stop === 'end_turn' ? 'stop' : (stop ?? 'stop');

  return {
    id: typeof anthropic?.id === 'string' ? anthropic.id : undefined,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof anthropic?.model === 'string' ? anthropic.model : requestedModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason,
      },
    ],
    ...(prompt_tokens !== undefined || completion_tokens !== undefined
      ? {
          usage: {
            prompt_tokens: prompt_tokens ?? 0,
            completion_tokens: completion_tokens ?? 0,
            total_tokens: (prompt_tokens ?? 0) + (completion_tokens ?? 0),
          },
        }
      : {}),
  };
}

/**
 * Anthropic error body -> the `{ error: { message } }` shape the client's
 * error path already understands.
 *
 * Without this an upstream 4xx would reach the client as an unrecognized blob
 * and surface as "no usable text" rather than the actual reason, which is
 * exactly the failure mode that made the original missing-route trap so hard
 * to see.
 */
export function toChatCompletionsError(anthropic: any, status: number): any {
  const message =
    (anthropic && anthropic.error && typeof anthropic.error.message === 'string'
      ? anthropic.error.message
      : undefined) ?? `Anthropic upstream error (${status})`;
  const type =
    anthropic && anthropic.error && typeof anthropic.error.type === 'string'
      ? anthropic.error.type
      : 'upstream_error';
  return { error: { message, type } };
}
