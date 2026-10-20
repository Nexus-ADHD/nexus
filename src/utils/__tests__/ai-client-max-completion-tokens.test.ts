/**
 * Wire-shape regression: the output-token cap goes out as
 * `max_completion_tokens`, NEVER the legacy `max_tokens`.
 *
 * This is the Strengthen-sheet retry-loop bug. Strengthen is the only
 * surface that passes a token cap, and it passed `max_tokens` — which the
 * gpt-5 family rejects with a deterministic 400 ("Unsupported parameter:
 * 'max_tokens'"). A 400 is fail-fast (not in RETRYABLE_STATUSES), so every
 * tap of RETRY re-sent the identical request and reproduced the identical
 * rejection. `max_completion_tokens` is the only spelling both the gpt-5
 * family and Kimi accept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as any).__DEV__ = false;
});

const supabaseMock = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock('../../services/supabase', () => ({
  supabase: {
    auth: {
      getSession: supabaseMock.getSession,
      refreshSession: supabaseMock.refreshSession,
    },
  },
}));

vi.mock('../public-config', () => ({
  publicConfigValue: (key: string) =>
    key === 'EXPO_PUBLIC_AI_PROXY_URL' ? 'https://proxy.test' : 'test-app-token',
}));

import { chatCompletion } from '../ai-client';

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

describe('chatCompletion wire shape: token cap field', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    supabaseMock.getSession.mockReset();
    supabaseMock.getSession.mockResolvedValue({
      data: { session: { access_token: 'jwt' } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends max_completion_tokens, not max_tokens', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: any) => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      chatCompletion(MESSAGES, { max_tokens: 800, timeoutMs: 15000 }),
    ).resolves.toBe('ok');

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.max_completion_tokens).toBe(800);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('omits the field entirely when no cap is passed', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: any) => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(chatCompletion(MESSAGES, { timeoutMs: 15000 })).resolves.toBe('ok');

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });
});
