/**
 * NEX-311 — pins the OpenAI <-> Anthropic dialect translation.
 *
 * These are the shapes that silently break a provider route: a system message
 * left in the array, a missing max_tokens, two consecutive same-role turns, a
 * content array the client cannot read, and usage keys the metrics span cannot
 * find. Each has a test because each is a 400 or a silent empty response in
 * production, and none of them is visible to `deno check`.
 *
 * Run: deno test --allow-import supabase/functions/_shared/anthropic-shape.test.ts
 * (CI's deno-check type-checks this file; behavior is gated by running it locally.)
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  isAnthropicModel,
  toAnthropicRequest,
  toChatCompletions,
  toChatCompletionsError,
  DEFAULT_MAX_TOKENS,
} from './anthropic-shape.ts';

// ─── provider selection ──────────────────────────────────────────────────────

Deno.test('isAnthropicModel routes only claude-* to Anthropic', () => {
  for (const m of ['claude-opus-4-5', 'claude-sonnet-4-5', 'CLAUDE-HAIKU-4-5']) {
    assert(isAnthropicModel(m), `${m} should route to Anthropic`);
  }
  for (const m of ['gpt-5.4', 'gpt-5.4-mini', 'o4-mini', 'chatgpt-4o', '', null, undefined, 42]) {
    assert(!isAnthropicModel(m as unknown), `${String(m)} must NOT route to Anthropic`);
  }
});

// ─── request translation ─────────────────────────────────────────────────────

Deno.test('system messages are hoisted out of the array, not sent as a role', () => {
  const out = toAnthropicRequest({
    model: 'claude-opus-4-5',
    messages: [
      { role: 'system', content: 'You are Nexus.' },
      { role: 'user', content: 'Suggest habits.' },
    ],
  });
  assertEquals(out.system, 'You are Nexus.');
  assertEquals(out.messages, [{ role: 'user', content: 'Suggest habits.' }]);
  // A leftover system role in the array is a hard 400 upstream.
  assert(!out.messages.some((m) => (m.role as string) === 'system'));
});

Deno.test('multiple system messages join in order', () => {
  const out = toAnthropicRequest({
    model: 'claude-opus-4-5',
    messages: [
      { role: 'system', content: 'Persona.' },
      { role: 'system', content: 'Rules.' },
      { role: 'user', content: 'Go.' },
    ],
  });
  assertEquals(out.system, 'Persona.\n\nRules.');
});

Deno.test('max_tokens is always present (Anthropic rejects the request without it)', () => {
  const noMax = toAnthropicRequest({ model: 'claude-opus-4-5', messages: [{ role: 'user', content: 'x' }] });
  assertEquals(noMax.max_tokens, DEFAULT_MAX_TOKENS);

  const explicit = toAnthropicRequest({ model: 'claude-opus-4-5', max_tokens: 512, messages: [{ role: 'user', content: 'x' }] });
  assertEquals(explicit.max_tokens, 512);

  // Garbage must not pass through as NaN/0/negative — all are rejected upstream.
  for (const bad of [0, -5, NaN, 'lots', null, undefined]) {
    const out = toAnthropicRequest({ model: 'c', max_tokens: bad, messages: [{ role: 'user', content: 'x' }] });
    assertEquals(out.max_tokens, DEFAULT_MAX_TOKENS, `max_tokens=${String(bad)} should fall back`);
  }
});

Deno.test('consecutive same-role turns are merged (Anthropic requires alternation)', () => {
  const out = toAnthropicRequest({
    model: 'claude-opus-4-5',
    messages: [
      { role: 'user', content: 'First.' },
      { role: 'user', content: 'Second.' },
      { role: 'assistant', content: 'Reply.' },
      { role: 'assistant', content: 'More.' },
      { role: 'user', content: 'Third.' },
    ],
  });
  assertEquals(out.messages, [
    { role: 'user', content: 'First.\n\nSecond.' },
    { role: 'assistant', content: 'Reply.\n\nMore.' },
    { role: 'user', content: 'Third.' },
  ]);
  // No two adjacent turns share a role.
  for (let i = 1; i < out.messages.length; i++) {
    assert(out.messages[i].role !== out.messages[i - 1].role);
  }
});

Deno.test('a leading assistant turn is dropped, never sent', () => {
  const out = toAnthropicRequest({
    model: 'claude-opus-4-5',
    messages: [
      { role: 'assistant', content: 'Unprompted.' },
      { role: 'user', content: 'Real question.' },
    ],
  });
  assertEquals(out.messages[0].role, 'user');
  assertEquals(out.messages.length, 1);
});

Deno.test('empty content is dropped rather than sent as an empty block', () => {
  const out = toAnthropicRequest({
    model: 'claude-opus-4-5',
    messages: [
      { role: 'user', content: '' },
      { role: 'user', content: 'Real.' },
      { role: 'user', content: null },
    ],
  });
  assertEquals(out.messages, [{ role: 'user', content: 'Real.' }]);
});

Deno.test('an array content payload is flattened to text', () => {
  const out = toAnthropicRequest({
    model: 'claude-opus-4-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
  });
  assertEquals(out.messages[0].content, 'a\nb');
});

Deno.test('temperature passes through; response_format is dropped', () => {
  const out: any = toAnthropicRequest({
    model: 'claude-opus-4-5',
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: 'x' }],
  });
  assertEquals(out.temperature, 0.4);
  assertEquals(out.response_format, undefined);
});

Deno.test('never throws on a malformed body', () => {
  for (const bad of [{}, { messages: null }, { messages: 'nope' }, null, undefined]) {
    const out = toAnthropicRequest(bad);
    assert(Array.isArray(out.messages));
    assertEquals(out.max_tokens, DEFAULT_MAX_TOKENS);
  }
});

// ─── response translation ────────────────────────────────────────────────────

Deno.test('content blocks become choices[0].message.content, which is all the client reads', () => {
  const out = toChatCompletions(
    {
      id: 'msg_1',
      model: 'claude-opus-4-5',
      content: [{ type: 'text', text: '{"habits":' }, { type: 'text', text: '[]}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 4 },
    },
    'claude-opus-4-5',
  );
  assertEquals(out.choices[0].message.content, '{"habits":[]}');
  assertEquals(out.choices[0].message.role, 'assistant');
  assertEquals(out.object, 'chat.completion');
});

Deno.test('non-text blocks are ignored, not stringified into the reply', () => {
  const out = toChatCompletions(
    { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }] },
    'claude-opus-4-5',
  );
  assertEquals(out.choices[0].message.content, 'answer');
});

Deno.test('usage is translated so the proxy metrics span still finds tokens', () => {
  const out = toChatCompletions({ content: [], usage: { input_tokens: 100, output_tokens: 25 } }, 'm');
  assertEquals(out.usage.prompt_tokens, 100);
  assertEquals(out.usage.completion_tokens, 25);
  assertEquals(out.usage.total_tokens, 125);
});

Deno.test('usage is omitted entirely when upstream sent none', () => {
  const out = toChatCompletions({ content: [{ type: 'text', text: 'x' }] }, 'm');
  assertEquals(out.usage, undefined);
});

Deno.test('stop_reason maps to finish_reason so truncation is visible', () => {
  assertEquals(toChatCompletions({ stop_reason: 'max_tokens' }, 'm').choices[0].finish_reason, 'length');
  assertEquals(toChatCompletions({ stop_reason: 'end_turn' }, 'm').choices[0].finish_reason, 'stop');
});

Deno.test('a garbage response yields an empty string, never a crash', () => {
  for (const bad of [null, undefined, {}, { content: 'nope' }, { content: [null, 42] }]) {
    const out = toChatCompletions(bad, 'claude-opus-4-5');
    assertEquals(out.choices[0].message.content, '');
    assertEquals(out.model, 'claude-opus-4-5'); // falls back to what was asked for
  }
});

// ─── error translation ───────────────────────────────────────────────────────

Deno.test('an upstream error keeps its real message instead of becoming an opaque blob', () => {
  const out = toChatCompletionsError(
    { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: required' } },
    400,
  );
  assertEquals(out.error.message, 'max_tokens: required');
  assertEquals(out.error.type, 'invalid_request_error');
});

Deno.test('an unparseable error body still produces a usable message', () => {
  const out = toChatCompletionsError(null, 529);
  assert(out.error.message.includes('529'));
  assertEquals(out.error.type, 'upstream_error');
});
