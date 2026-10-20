/**
 * Pins the Kimi (Moonshot) provider route for ai-proxy.
 *
 * Kimi speaks OpenAI's dialect, so there is no dialect translation to pin —
 * only the things that actually break the route: provider selection (a
 * kimi-* id must never fall through to api.openai.com, where it is an
 * unrecognized model and a deterministic 400), the legacy `max_tokens`
 * rename (the field OpenAI's gpt-5 family 400s on — the Strengthen-sheet
 * retry-loop bug), and NEX-327's two guards: the retired `kimi-k2.5` ->
 * `kimi-k2.6` alias (upstream 404s the retired id) and the default
 * `thinking: disabled` injection (thinking-on burns a capped token budget on
 * reasoning_content and returns truncated JSON).
 *
 * Run: deno test --allow-import supabase/functions/_shared/kimi-shape.test.ts
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isKimiModel, toKimiRequest } from './kimi-shape.ts';

// ─── provider selection ──────────────────────────────────────────────────────

Deno.test('isKimiModel routes only kimi-* to Kimi', () => {
  for (const m of ['kimi-k2.6', 'kimi-k2.5', 'kimi-k3', 'KIMI-K2.7-CODE']) {
    assert(isKimiModel(m), `${m} should route to Kimi`);
  }
  for (const m of ['gpt-5.4', 'o4-mini', 'chatgpt-4o', 'claude-opus-4-5', 'moonshot-v1-8k', '', null, undefined, 42]) {
    assert(!isKimiModel(m as unknown), `${String(m)} must NOT route to Kimi`);
  }
});

// ─── max_tokens rename ───────────────────────────────────────────────────────

Deno.test('toKimiRequest renames a legacy max_tokens to max_completion_tokens', () => {
  const out = toKimiRequest({ model: 'kimi-k2.5', messages: [], max_tokens: 800 });
  assertEquals(out.max_completion_tokens, 800);
  assert(!('max_tokens' in out), 'legacy field must not reach Kimi');
});

Deno.test('toKimiRequest leaves everything else verbatim', () => {
  const body = {
    model: 'kimi-k2.6',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_object' },
    max_completion_tokens: 800,
  };
  // A served model id passes through unchanged; the only addition is the
  // default thinking-off (pinned separately below).
  assertEquals(toKimiRequest(body), { ...body, thinking: { type: 'disabled' } });
});

Deno.test('toKimiRequest: an explicit max_completion_tokens always wins', () => {
  const out = toKimiRequest({ model: 'kimi-k2.5', messages: [], max_tokens: 100, max_completion_tokens: 800 });
  assertEquals(out.max_completion_tokens, 800);
});

Deno.test('toKimiRequest drops a junk max_tokens rather than sending it', () => {
  for (const bad of [0, -1, NaN, Infinity, '800']) {
    const out = toKimiRequest({ model: 'kimi-k2.5', messages: [], max_tokens: bad });
    assert(!('max_tokens' in out), `max_tokens=${String(bad)} must not pass through`);
    assert(!('max_completion_tokens' in out), `max_tokens=${String(bad)} must not invent a cap`);
  }
});

Deno.test('toKimiRequest tolerates a non-object body', () => {
  assertEquals(toKimiRequest(undefined), undefined);
  assertEquals(toKimiRequest(null), null);
});

// ─── NEX-327: retired-model alias ────────────────────────────────────────────

Deno.test('toKimiRequest remaps the retired kimi-k2.5 to kimi-k2.6', () => {
  // Verified live 2026-08-06: GET /v1/models on api.moonshot.ai serves only
  // kimi-k2.6 / kimi-k3 / kimi-k2.7-code / kimi-k2.7-code-highspeed; kimi-k2.5
  // 404s ("model not found") on every chat call. The alias fixes
  // already-installed app builds server-side, without an app release.
  const out = toKimiRequest({ model: 'kimi-k2.5', messages: [], max_completion_tokens: 800 });
  assertEquals(out.model, 'kimi-k2.6');
});

Deno.test('toKimiRequest alias match is case-insensitive', () => {
  const out = toKimiRequest({ model: 'KIMI-K2.5', messages: [] });
  assertEquals(out.model, 'kimi-k2.6');
});

Deno.test('toKimiRequest passes a served model through unchanged', () => {
  for (const m of ['kimi-k2.6', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed']) {
    assertEquals(toKimiRequest({ model: m, messages: [] }).model, m);
  }
});

// ─── NEX-327: thinking off by default ────────────────────────────────────────

Deno.test('toKimiRequest injects thinking: disabled when the body has none', () => {
  // This app never surfaces reasoning. With thinking enabled, an 800-token
  // cap is consumed by reasoning_content and the completion returns truncated
  // JSON (finish_reason=length) — verified live 2026-08-06 with the exact
  // Strengthen payload (14.8s truncated vs. 3.9s complete with thinking off).
  const out = toKimiRequest({ model: 'kimi-k2.6', messages: [], max_completion_tokens: 800 });
  assertEquals(out.thinking, { type: 'disabled' });
});

Deno.test('toKimiRequest: a caller-provided thinking always wins', () => {
  const enabled = { type: 'enabled' };
  assertEquals(toKimiRequest({ model: 'kimi-k2.6', messages: [], thinking: enabled }).thinking, enabled);
  assertEquals(toKimiRequest({ model: 'kimi-k2.6', messages: [], thinking: { type: 'disabled' } }).thinking, { type: 'disabled' });
});
