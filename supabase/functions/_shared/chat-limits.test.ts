import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { boundChatRequest, CHAT_MAX_OUTPUT_TOKENS } from './chat-limits.ts';

Deno.test('premium models the app never uses are refused', () => {
  for (const model of ['o1', 'o1-preview', 'o3-pro', 'gpt-4.5-preview', 'o4-mini-deep-research', 'gpt-5-pro']) {
    assertEquals(boundChatRequest({ model }, false), { ok: false, error: 'model_not_allowed' }, model);
  }
});

Deno.test('the app\'s own models pass untouched apart from the cap', () => {
  for (const model of ['gpt-5.4', 'o4-mini', 'o3-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini', 'kimi-k2.6']) {
    const r = boundChatRequest({ model, messages: [] }, false);
    assertEquals(r.ok, true, model);
  }
});

Deno.test('n is forced to 1 and oversized caps are clamped', () => {
  const r = boundChatRequest({ model: 'gpt-5.4', n: 50, max_completion_tokens: 1_000_000 }, false);
  assertEquals(r.ok && r.body.n, 1);
  assertEquals(r.ok && r.body.max_completion_tokens, CHAT_MAX_OUTPUT_TOKENS);
});

Deno.test('a sane cap is kept as sent', () => {
  const r = boundChatRequest({ model: 'gpt-5.4', max_completion_tokens: 800 }, false);
  assertEquals(r.ok && r.body.max_completion_tokens, 800);
});

Deno.test('absent cap: set for OpenAI/Kimi, left to the Anthropic default', () => {
  const o = boundChatRequest({ model: 'o4-mini' }, false);
  assertEquals(o.ok && o.body.max_completion_tokens, CHAT_MAX_OUTPUT_TOKENS);
  const a = boundChatRequest({ model: 'claude-opus-4-5' }, true);
  assertEquals(a.ok && 'max_completion_tokens' in a.body, false);
});

Deno.test('garbage caps are dropped, not forwarded', () => {
  const r = boundChatRequest({ model: 'claude-opus-4-5', max_tokens: 'lots' }, true);
  assertEquals(r.ok && 'max_tokens' in r.body, false);
});
