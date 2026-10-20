/**
 * Mandate Strengthen suggestion-fetch policy.
 *
 * Pins the contract extracted out of mandate-strengthen-sheet.tsx: json_object
 * mode + a max_tokens cap on every attempt, a valid-but-empty payload is a
 * real result (not a parse failure), ONE silent retry shared between a parse
 * failure and a fast-thrown error but bounded by the REMAINING budget (never
 * a fresh 30s), and AiTimeoutError/SessionTimeoutError are never retried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchStrengthenSuggestions,
  parsePayload,
  STRENGTHEN_TIMEOUT_MS,
} from '../strengthen-suggestions';

const PROMPT = { system: 'You generate habits.', user: 'Mandate: "Build Wealth"' };

function jsonReply(habits: unknown[], todos: unknown[]): string {
  return JSON.stringify({ habits, todos });
}

describe('parsePayload', () => {
  it('parses JSON wrapped in markdown fences', () => {
    const raw = '```json\n' + jsonReply([{ title: 'Lift 4x/week', rationale: 'r' }], []) + '\n```';
    expect(parsePayload(raw)).toEqual({
      habits: [{ title: 'Lift 4x/week', rationale: 'r' }],
      todos: [],
    });
  });

  it('returns null for malformed JSON', () => {
    expect(parsePayload('{not valid')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parsePayload('')).toBeNull();
  });

  it('valid JSON with both arrays empty returns an empty payload, not null', () => {
    // The NEX-76 empty-state UI depends on this being kind:'ok', not a parse
    // failure — before extraction, this case was misrouted into the
    // parse-retry path and could never reach the empty-state branch.
    expect(parsePayload(jsonReply([], []))).toEqual({ habits: [], todos: [] });
  });

  it('slices over-length arrays to 3 habits / 2 todos', () => {
    const habits = Array.from({ length: 5 }, (_, i) => ({ title: `H${i}`, rationale: 'r' }));
    const todos = Array.from({ length: 4 }, (_, i) => ({ title: `T${i}`, rationale: 'r' }));
    const result = parsePayload(jsonReply(habits, todos))!;
    expect(result.habits).toHaveLength(3);
    expect(result.todos).toHaveLength(2);
  });

  it('filters out blank titles', () => {
    const result = parsePayload(
      jsonReply([{ title: '  ', rationale: 'r' }, { title: 'Real one', rationale: 'r' }], []),
    )!;
    expect(result.habits).toEqual([{ title: 'Real one', rationale: 'r' }]);
  });
});

describe('fetchStrengthenSuggestions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls chat with json_object mode, a model, max_tokens 800, and the full budget on the first attempt', async () => {
    const chat = vi.fn().mockResolvedValue(jsonReply([{ title: 'H', rationale: 'r' }], []));
    const result = await fetchStrengthenSuggestions(PROMPT, chat);

    expect(result).toEqual({ kind: 'ok', payload: { habits: [{ title: 'H', rationale: 'r' }], todos: [] } });
    expect(chat).toHaveBeenCalledTimes(1);
    const [messages, options] = chat.mock.calls[0];
    expect(messages).toEqual([
      { role: 'system', content: PROMPT.system },
      { role: 'user', content: PROMPT.user },
    ]);
    expect(options.response_format).toEqual({ type: 'json_object' });
    expect(options.max_tokens).toBe(800);
    expect(options.timeoutMs).toBe(STRENGTHEN_TIMEOUT_MS);
    expect(typeof options.model).toBe('string');
    expect(options.model.length).toBeGreaterThan(0);
  });

  it('a valid-empty payload is kind:ok and does NOT consume the retry', async () => {
    const chat = vi.fn().mockResolvedValue(jsonReply([], []));
    const result = await fetchStrengthenSuggestions(PROMPT, chat);
    expect(result).toEqual({ kind: 'ok', payload: { habits: [], todos: [] } });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('retries once on a parse failure and succeeds', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce('not json at all')
      .mockResolvedValueOnce(jsonReply([{ title: 'H', rationale: 'r' }], []));
    const result = await fetchStrengthenSuggestions(PROMPT, chat);
    expect(result).toEqual({ kind: 'ok', payload: { habits: [{ title: 'H', rationale: 'r' }], todos: [] } });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('two parse failures return kind: parse', async () => {
    const chat = vi.fn().mockResolvedValue('still not json');
    const result = await fetchStrengthenSuggestions(PROMPT, chat);
    expect(result).toEqual({ kind: 'parse' });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('retries once on a fast-thrown error (e.g. an upstream 500) and succeeds', async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new Error('AI request failed (500): boom'))
      .mockResolvedValueOnce(jsonReply([{ title: 'H', rationale: 'r' }], []));
    const result = await fetchStrengthenSuggestions(PROMPT, chat);
    expect(result.kind).toBe('ok');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('two fast-thrown failures return kind: failed', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('AI request failed (500): boom'));
    const result = await fetchStrengthenSuggestions(PROMPT, chat);
    expect(result).toEqual({ kind: 'failed' });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('AiTimeoutError is never retried', async () => {
    class AiTimeoutError extends Error {
      constructor() {
        super('AI request timed out.');
        this.name = 'AiTimeoutError';
      }
    }
    const chat = vi.fn().mockRejectedValue(new AiTimeoutError());
    const result = await fetchStrengthenSuggestions(PROMPT, chat);
    expect(result).toEqual({ kind: 'timeout' });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('SessionTimeoutError is never retried', async () => {
    class SessionTimeoutError extends Error {
      constructor() {
        super('Auth session lookup timed out.');
        this.name = 'SessionTimeoutError';
      }
    }
    const chat = vi.fn().mockRejectedValue(new SessionTimeoutError());
    const result = await fetchStrengthenSuggestions(PROMPT, chat);
    expect(result).toEqual({ kind: 'timeout' });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('bounds the retry by the REMAINING budget, not a fresh 30s', async () => {
    // First attempt "takes" 20s of the 30s budget before failing fast.
    const chat = vi
      .fn()
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(20000);
        throw new Error('AI request failed (500): slow-fail');
      })
      .mockImplementationOnce(async () => jsonReply([{ title: 'H', rationale: 'r' }], []));

    const result = await fetchStrengthenSuggestions(PROMPT, chat);
    expect(result.kind).toBe('ok');
    expect(chat).toHaveBeenCalledTimes(2);
    const secondOptions = chat.mock.calls[1][1];
    // ~10s remaining (30s budget - 20s already elapsed), not a fresh 30s.
    expect(secondOptions.timeoutMs).toBe(STRENGTHEN_TIMEOUT_MS - 20000);
  });

  it('skips the retry entirely when the first attempt leaves too little budget', async () => {
    // First attempt eats 27s of the 30s budget — under 4s remains, below the
    // floor worth starting a second network call for.
    const chat = vi.fn().mockImplementationOnce(async () => {
      vi.advanceTimersByTime(27000);
      throw new Error('AI request failed (500): very-slow-fail');
    });

    const result = await fetchStrengthenSuggestions(PROMPT, chat);
    expect(result).toEqual({ kind: 'failed' });
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
