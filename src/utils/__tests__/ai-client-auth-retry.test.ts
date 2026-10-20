/**
 * 401 stale-JWT recovery in fetchWithRetry (via chatCompletion/transcribeAudio).
 *
 * The first AI call after long backgrounding can race supabase-js's lazy
 * token refresh and lose: the proxy 401s the stale JWT and, before this
 * existed, the client failed fast — every AI surface (capture, Strengthen,
 * transcription) showed a generic failure until the SDK caught up. These
 * tests pin the recovery contract: ONE silent refreshSession() + retry per
 * call, single-flight across parallel callers, failure never cached, app-token
 * 401s never refreshed, and the retried fetch still governed by the deadline.
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

import { chatCompletion, transcribeAudio, AiTimeoutError } from '../ai-client';

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

function res200(content = 'hello') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function res401(body = 'Missing user authorization') {
  return {
    ok: false,
    status: 401,
    clone: () => ({ text: async () => body }),
    text: async () => body,
  };
}

function res503() {
  return {
    ok: false,
    status: 503,
    text: async () => 'unavailable',
  };
}

/** fetch returning queued responses in order; extra calls repeat the last. */
function queuedFetch(queue: any[]) {
  let i = 0;
  return vi.fn(async (_url: string, _init?: any) => queue[Math.min(i++, queue.length - 1)]);
}

function sessionOk(token = 'stale-jwt') {
  supabaseMock.getSession.mockResolvedValue({
    data: { session: { access_token: token } },
  });
}

function refreshOk(token = 'fresh-jwt') {
  supabaseMock.refreshSession.mockResolvedValue({
    data: { session: { access_token: token } },
  });
}

describe('chatCompletion 401 refresh-and-retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    supabaseMock.getSession.mockReset();
    supabaseMock.refreshSession.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('recovers a stale-JWT 401: one refresh, retried request carries the new token', async () => {
    sessionOk('stale-jwt');
    refreshOk('fresh-jwt');
    const fetchSpy = queuedFetch([res401('Invalid user authorization'), res200('recovered')]);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(chatCompletion(MESSAGES, { timeoutMs: 15000 })).resolves.toBe('recovered');
    expect(supabaseMock.refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const retryHeaders = fetchSpy.mock.calls[1][1].headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer fresh-jwt');
    expect(retryHeaders['X-App-Token']).toBe('test-app-token');
  });

  it('surfaces the original 401 when the refresh fails, with no second fetch', async () => {
    sessionOk();
    supabaseMock.refreshSession.mockRejectedValue(new Error('gotrue down'));
    const fetchSpy = queuedFetch([res401()]);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(chatCompletion(MESSAGES, { timeoutMs: 15000 })).rejects.toThrow(
      /AI request failed \(401\)/,
    );
    expect(supabaseMock.refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a 401 after the refresh retry surfaces without a second refresh', async () => {
    sessionOk();
    refreshOk();
    const fetchSpy = queuedFetch([res401(), res401()]);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(chatCompletion(MESSAGES, { timeoutMs: 15000 })).rejects.toThrow(
      /AI request failed \(401\)/,
    );
    expect(supabaseMock.refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('never refreshes an app-token 401 (config failure fails fast unchanged)', async () => {
    sessionOk();
    refreshOk();
    const fetchSpy = queuedFetch([res401('Invalid app token')]);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(chatCompletion(MESSAGES, { timeoutMs: 15000 })).rejects.toThrow(
      /AI request failed \(401\)/,
    );
    expect(supabaseMock.refreshSession).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('the auth retry does not consume a network attempt (401 → refresh → 503 → 503 → 200)', async () => {
    sessionOk();
    refreshOk();
    const fetchSpy = queuedFetch([res401(), res503(), res503(), res200('eventually')]);
    vi.stubGlobal('fetch', fetchSpy);

    const call = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    const assertion = expect(call).resolves.toBe('eventually');
    // Two backoff sleeps (300ms, 800ms nominal + jitter) sit between the 503s.
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(supabaseMock.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('parallel 401s share a single refreshSession (single-flight)', async () => {
    sessionOk();
    supabaseMock.refreshSession.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ data: { session: { access_token: 'fresh-jwt' } } }), 50),
        ),
    );
    const fetchSpy = vi.fn(async (_url: string, init: any) => {
      const headers = init.headers as Record<string, string>;
      return headers.Authorization === 'Bearer fresh-jwt' ? res200('ok') : res401();
    });
    vi.stubGlobal('fetch', fetchSpy);

    const a = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    const b = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    const assertions = Promise.all([
      expect(a).resolves.toBe('ok'),
      expect(b).resolves.toBe('ok'),
    ]);
    await vi.advanceTimersByTimeAsync(100);
    await assertions;
    expect(supabaseMock.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('a failed refresh is not cached: the next call refreshes anew and succeeds', async () => {
    sessionOk();
    supabaseMock.refreshSession
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ data: { session: { access_token: 'fresh-jwt' } } });
    const fetchSpy = vi.fn(async (_url: string, init: any) => {
      const headers = init.headers as Record<string, string>;
      return headers.Authorization === 'Bearer fresh-jwt' ? res200('ok') : res401();
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(chatCompletion(MESSAGES, { timeoutMs: 15000 })).rejects.toThrow(
      /AI request failed \(401\)/,
    );
    await expect(chatCompletion(MESSAGES, { timeoutMs: 15000 })).resolves.toBe('ok');
    expect(supabaseMock.refreshSession).toHaveBeenCalledTimes(2);
  });

  it('the retried fetch is still governed by the deadline (hang → AiTimeoutError)', async () => {
    sessionOk();
    refreshOk();
    let calls = 0;
    const fetchSpy = vi.fn((_url: string, init: any) => {
      calls++;
      if (calls === 1) return Promise.resolve(res401());
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const call = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    const assertion = expect(call).rejects.toBeInstanceOf(AiTimeoutError);
    await vi.advanceTimersByTimeAsync(15001);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('transcribeAudio 401 refresh-and-retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    supabaseMock.getSession.mockReset();
    supabaseMock.refreshSession.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('recovers a stale-JWT 401 and keeps multipart headers intact on the retry', async () => {
    sessionOk();
    refreshOk('fresh-jwt');
    // Trailing period short-circuits addPunctuation (no extra chat fetch).
    const okTranscribe = {
      ok: true,
      status: 200,
      json: async () => ({ text: 'the whole point.' }),
    };
    const fetchSpy = queuedFetch([res401(), okTranscribe]);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(transcribeAudio('file:///audio.m4a')).resolves.toBe('the whole point.');
    expect(supabaseMock.refreshSession).toHaveBeenCalledTimes(1);
    const retryHeaders = fetchSpy.mock.calls[1][1].headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer fresh-jwt');
    // Content-Type stays absent so fetch generates the multipart boundary.
    expect(retryHeaders['Content-Type']).toBeUndefined();
  });
});

describe('401 refresh across sign-out (Greptile T-Rex round 3, PR #488)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    supabaseMock.getSession.mockReset();
    supabaseMock.refreshSession.mockReset();
    const { clearAiSessionCache } = await import('../ai-session-cache');
    clearAiSessionCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("account B's 401 recovery never joins a refresh account A started before signing out", async () => {
    const { clearAiSessionCache } = await import('../ai-session-cache');
    // A's request 401s and its refresh is in flight (never settles until we say so).
    let resolveA: (v: unknown) => void = () => {};
    supabaseMock.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-A' } } });
    supabaseMock.refreshSession.mockReturnValueOnce(new Promise((r) => { resolveA = r; }));
    const fetchA = vi.fn().mockResolvedValueOnce(res401()).mockResolvedValue(res200('a'));
    vi.stubGlobal('fetch', fetchA);
    const callA = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    await vi.advanceTimersByTimeAsync(10);
    // A signs out; B signs in. B's request also 401s and must run its OWN refresh.
    clearAiSessionCache();
    supabaseMock.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-B-stale' } } });
    supabaseMock.refreshSession.mockResolvedValueOnce({ data: { session: { access_token: 'fresh-B' } } });
    const fetchB = vi.fn().mockResolvedValueOnce(res401()).mockResolvedValueOnce(res200('b'));
    vi.stubGlobal('fetch', fetchB);
    await expect(chatCompletion(MESSAGES, { timeoutMs: 15000 })).resolves.toBe('b');
    expect(supabaseMock.refreshSession).toHaveBeenCalledTimes(2);
    expect((fetchB.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe('Bearer fresh-B');
    // A's refresh finally lands: A's request (a stale generation) gets no retry, and A's token
    // is neither cached nor handed to anyone; the cache holds B's own fresh token.
    resolveA({ data: { session: { access_token: 'fresh-A' } } });
    await expect(callA).rejects.toThrow(/AI request failed \(401/);
    const { lastKnownAccessTokenOrNull } = await import('../ai-session-cache');
    expect(lastKnownAccessTokenOrNull()).toBe('fresh-B');
  });
});
