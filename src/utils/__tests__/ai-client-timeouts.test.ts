/**
 * NEX-280 — chatCompletion + transcribeAudio deadline semantics.
 *
 * The Command capture path hung forever (and bricked the orb's tap guard)
 * when either the auth-session lookup or the proxy fetch stalled. These tests
 * pin the contract: `timeoutMs` bounds BOTH phases with typed errors,
 * omitting it applies DEFAULT_AI_TIMEOUT_MS (every caller is bounded by
 * default — PR #314's hang class), and `timeoutMs: 0` opts out entirely.
 * transcribeAudio carries the same contract for its upload phase.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as any).__DEV__ = false;
});

const supabaseMock = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock('../../services/supabase', () => ({
  supabase: { auth: { getSession: supabaseMock.getSession } },
}));

vi.mock('../public-config', () => ({
  publicConfigValue: (key: string) =>
    key === 'EXPO_PUBLIC_AI_PROXY_URL' ? 'https://proxy.test' : 'test-app-token',
}));

import {
  chatCompletion,
  transcribeAudio,
  AiTimeoutError,
  SessionTimeoutError,
  DEFAULT_AI_TIMEOUT_MS,
  aiDiagnosticsOf,
} from '../ai-client';
import { clearAiSessionCache } from '../ai-session-cache';

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

function okFetch(content = 'hello') {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

/** A fetch that never settles unless its AbortSignal fires (rejects AbortError). */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  );
}

describe('chatCompletion timeoutMs (NEX-280)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    supabaseMock.getSession.mockReset();
    // The last-known-token fallback is per module; a token cached by an
    // earlier test must not turn a hung lookup into a success here.
    clearAiSessionCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('throws SessionTimeoutError when getSession hangs — and never sends a JWT-less request', async () => {
    supabaseMock.getSession.mockReturnValue(new Promise(() => {}));
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const call = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    const assertion = expect(call).rejects.toBeInstanceOf(SessionTimeoutError);
    // Session phase is capped at min(6s, timeoutMs).
    await vi.advanceTimersByTimeAsync(6001);
    await assertion;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws AiTimeoutError when the fetch phase exceeds the budget', async () => {
    supabaseMock.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } } });
    const fetchSpy = hangingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const call = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    const assertion = expect(call).rejects.toBeInstanceOf(AiTimeoutError);
    await vi.advanceTimersByTimeAsync(15001);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves normally within the budget and attaches the JWT', async () => {
    supabaseMock.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } } });
    const fetchSpy = okFetch('parsed');
    vi.stubGlobal('fetch', fetchSpy);

    await expect(chatCompletion(MESSAGES, { timeoutMs: 15000 })).resolves.toBe('parsed');
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt');
  });

  it('without timeoutMs, the default deadline applies (AiTimeoutError on a hung fetch)', async () => {
    supabaseMock.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } } });
    const fetchSpy = hangingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const call = chatCompletion(MESSAGES);
    const assertion = expect(call).rejects.toBeInstanceOf(AiTimeoutError);
    await vi.advanceTimersByTimeAsync(DEFAULT_AI_TIMEOUT_MS + 1);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].signal).toBeDefined();
  });

  it('without timeoutMs, the default deadline also bounds a hung getSession', async () => {
    supabaseMock.getSession.mockReturnValue(new Promise(() => {}));
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const call = chatCompletion(MESSAGES);
    const assertion = expect(call).rejects.toBeInstanceOf(SessionTimeoutError);
    // Session phase is capped at min(SESSION_LOOKUP_CAP_MS=6s, default budget).
    await vi.advanceTimersByTimeAsync(6001);
    await assertion;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('timeoutMs: 0 opts out of the deadline entirely (unbounded legacy behavior)', async () => {
    supabaseMock.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } } });
    const fetchSpy = okFetch('legacy');
    vi.stubGlobal('fetch', fetchSpy);

    await expect(chatCompletion(MESSAGES, { timeoutMs: 0 })).resolves.toBe('legacy');
    // No AbortSignal is wired when the caller explicitly opted out.
    expect(fetchSpy.mock.calls[0][1].signal).toBeUndefined();
  });

  it('keeps the legacy silent-omit on a non-timeout getSession failure', async () => {
    supabaseMock.getSession.mockRejectedValue(new Error('gotrue boom'));
    const fetchSpy = okFetch('no-jwt');
    vi.stubGlobal('fetch', fetchSpy);

    await expect(chatCompletion(MESSAGES, { timeoutMs: 15000 })).resolves.toBe('no-jwt');
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-App-Token']).toBe('test-app-token');
  });
});

/** A fetch that returns an OK transcription response (already-punctuated text
 *  short-circuits addPunctuation, so no second chatCompletion fetch fires). */
function okTranscribeFetch(text = 'hello world.') {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ text }),
  });
}

describe('transcribeAudio timeoutMs (NEX-280)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    supabaseMock.getSession.mockReset();
    // The last-known-token fallback is per module; a token cached by an
    // earlier test must not turn a hung lookup into a success here.
    clearAiSessionCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('throws AiTimeoutError when the upload fetch exceeds the default budget', async () => {
    supabaseMock.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } } });
    const fetchSpy = hangingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const call = transcribeAudio('file:///audio.m4a');
    const assertion = expect(call).rejects.toBeInstanceOf(AiTimeoutError);
    await vi.advanceTimersByTimeAsync(DEFAULT_AI_TIMEOUT_MS + 1);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].signal).toBeDefined();
  });

  it('throws SessionTimeoutError when getSession hangs — and never uploads', async () => {
    supabaseMock.getSession.mockReturnValue(new Promise(() => {}));
    const fetchSpy = okTranscribeFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const call = transcribeAudio('file:///audio.m4a');
    const assertion = expect(call).rejects.toBeInstanceOf(SessionTimeoutError);
    await vi.advanceTimersByTimeAsync(6001);
    await assertion;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves the transcription within the budget', async () => {
    supabaseMock.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } } });
    const fetchSpy = okTranscribeFetch('the whole point.');
    vi.stubGlobal('fetch', fetchSpy);

    await expect(transcribeAudio('file:///audio.m4a')).resolves.toBe('the whole point.');
  });

  it('timeoutMs: 0 opts out of the deadline (no AbortSignal wired)', async () => {
    supabaseMock.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } } });
    const fetchSpy = okTranscribeFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(transcribeAudio('file:///audio.m4a', { timeoutMs: 0 })).resolves.toBe('hello world.');
    expect(fetchSpy.mock.calls[0][1].signal).toBeUndefined();
  });
});

describe('chatCompletion last-known token fallback (coach builds 255/256)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    supabaseMock.getSession.mockReset();
    clearAiSessionCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a wedged getSession reuses the token from the previous successful lookup and records the fallback', async () => {
    supabaseMock.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'jwt-1' } } });
    const fetchSpy = okFetch('first');
    vi.stubGlobal('fetch', fetchSpy);
    await expect(chatCompletion(MESSAGES, { timeoutMs: 15000 })).resolves.toBe('first');

    // The second lookup never settles (auth-js waiting on its own refresh).
    supabaseMock.getSession.mockReturnValue(new Promise(() => {}));
    const call = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    await vi.advanceTimersByTimeAsync(6001);
    await expect(call).resolves.toBe('first');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const headers = fetchSpy.mock.calls[1][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-1');
  });

  it('a wedge that still fails carries its own diagnostics on the error (never a module global another call wrote)', async () => {
    supabaseMock.getSession.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', okFetch());
    const call = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    let caught: unknown;
    const settled = call.catch((e) => { caught = e; });
    await vi.advanceTimersByTimeAsync(6001);
    await settled;
    expect(caught).toBeInstanceOf(SessionTimeoutError);
    const diag = aiDiagnosticsOf(caught);
    expect(diag?.sessionFallback).toBe(false);
    expect(diag?.sessionMs).toBeGreaterThanOrEqual(6000);
    expect(aiDiagnosticsOf(new Error('plain'))).toBeNull();
  });

  it('a wedge rescued by the cache then timing out on the network reports the fallback on the AiTimeoutError', async () => {
    supabaseMock.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'jwt-1' } } });
    vi.stubGlobal('fetch', okFetch('first'));
    await chatCompletion(MESSAGES, { timeoutMs: 15000 });
    supabaseMock.getSession.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', hangingFetch());
    const call = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    let caught: unknown;
    const settled = call.catch((e) => { caught = e; });
    await vi.advanceTimersByTimeAsync(15001 + 6001);
    await settled;
    expect(caught).toBeInstanceOf(AiTimeoutError);
    expect(aiDiagnosticsOf(caught)?.sessionFallback).toBe(true);
  });

  it('a lookup that resolves AFTER sign-out never repopulates the cache for the next account (T-Rex, PR #488)', async () => {
    // Account A's lookup is in flight when A signs out.
    let resolveA: (v: unknown) => void = () => {};
    supabaseMock.getSession.mockReturnValueOnce(new Promise((r) => { resolveA = r; }));
    const fetchSpy = okFetch('a');
    vi.stubGlobal('fetch', fetchSpy);
    const callA = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    clearAiSessionCache(); // sign-out
    resolveA({ data: { session: { access_token: 'token-A' } } });
    await callA;
    // Account B's first lookup wedges: with A's late token kept out of the
    // cache, this is a hard failure, never a request under A's identity.
    supabaseMock.getSession.mockReturnValue(new Promise(() => {}));
    const callB = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    const assertion = expect(callB).rejects.toBeInstanceOf(SessionTimeoutError);
    await vi.advanceTimersByTimeAsync(6001);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a request that began before sign-out never reuses the token the NEXT account cached (T-Rex round 2)', async () => {
    // Account A's lookup is in flight and will wedge.
    supabaseMock.getSession.mockReturnValueOnce(new Promise(() => {}));
    const fetchSpy = okFetch('b');
    vi.stubGlobal('fetch', fetchSpy);
    const callA = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    const assertion = expect(callA).rejects.toBeInstanceOf(SessionTimeoutError);
    // A signs out; B signs in and completes a call, which caches B's token.
    clearAiSessionCache();
    supabaseMock.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'token-B' } } });
    await expect(chatCompletion(MESSAGES, { timeoutMs: 15000 })).resolves.toBe('b');
    // A's lookup now hits its cap: the fallback must not hand A's words to the proxy as B.
    await vi.advanceTimersByTimeAsync(6001);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer token-B');
  });

  it('clearAiSessionCache (sign-out) makes the next wedge a hard failure again', async () => {
    supabaseMock.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'jwt-A' } } });
    const fetchSpy = okFetch('a');
    vi.stubGlobal('fetch', fetchSpy);
    await chatCompletion(MESSAGES, { timeoutMs: 15000 });
    clearAiSessionCache();
    supabaseMock.getSession.mockReturnValue(new Promise(() => {}));
    const call = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    const assertion = expect(call).rejects.toBeInstanceOf(SessionTimeoutError);
    await vi.advanceTimersByTimeAsync(6001);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a wedged getSession with nothing cached is still a hard SessionTimeoutError and sends nothing', async () => {
    supabaseMock.getSession.mockReturnValue(new Promise(() => {}));
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const call = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    const assertion = expect(call).rejects.toBeInstanceOf(SessionTimeoutError);
    await vi.advanceTimersByTimeAsync(6001);
    await assertion;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a cached token that the proxy rejects still gets the one refresh + retry', async () => {
    supabaseMock.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'jwt-old' } } });
    const fetchSpy = okFetch('one');
    vi.stubGlobal('fetch', fetchSpy);
    await chatCompletion(MESSAGES, { timeoutMs: 15000 });

    supabaseMock.getSession.mockReturnValue(new Promise(() => {}));
    (supabaseMock as any).refreshSession = vi.fn().mockResolvedValue({ data: { session: { access_token: 'jwt-new' } } });
    const { supabase } = await import('../../services/supabase');
    (supabase.auth as any).refreshSession = (supabaseMock as any).refreshSession;
    const unauthorized = { ok: false, status: 401, clone: () => ({ text: async () => 'Missing user authorization' }), text: async () => 'Missing user authorization' };
    const retryFetch = vi
      .fn()
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'two' } }] }) });
    vi.stubGlobal('fetch', retryFetch);
    const call = chatCompletion(MESSAGES, { timeoutMs: 15000 });
    await vi.advanceTimersByTimeAsync(6001);
    await expect(call).resolves.toBe('two');
    const headers = retryFetch.mock.calls[1][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-new');
  });
});
