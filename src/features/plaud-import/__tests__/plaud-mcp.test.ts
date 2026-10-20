import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callPlaudToolWithToken,
  fetchPlaudTranscriptSource,
  parsePlaudJsonRpcResponse,
  PlaudTranscriptTooLargeError,
  projectPlaudRecordings,
  PLAUD_MAX_TRANSCRIPT_CHARS,
  attemptTimeoutMs,
  PlaudDeadlineError,
} from '../plaud-mcp';

function toolResponse(id: number, text: string) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }] },
  });
}

function transcriptPage(
  offset: number,
  segments: Record<string, unknown>[],
  nextCursor: string | null,
) {
  return JSON.stringify({
    offset,
    next_cursor: nextCursor,
    segments,
  });
}

describe('PLAUD MCP transport', () => {
  it('sends only an authenticated read-only tool call with the protocol header', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer token',
        'MCP-Protocol-Version': '2025-06-18',
      });
      expect(body).toMatchObject({
        method: 'tools/call',
        params: { name: 'list_files', arguments: { page: 1, page_size: 20 } },
      });
      return new Response(toolResponse(body.id, '{"data":[]}'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(
      callPlaudToolWithToken(
        'token',
        'list_files',
        { page: 1, page_size: 20 },
        fetchMock,
      ),
    ).resolves.toBe('{"data":[]}');
  });

  it('parses an SSE JSON-RPC response', () => {
    const sse = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"ok"}]}}',
      '',
    ].join('\n');
    expect(parsePlaudJsonRpcResponse(sse, 'text/event-stream', 7)).toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    });
  });

  it('projects only picker-safe recording fields', () => {
    const recordings = projectPlaudRecordings(JSON.stringify({
      type: 'list',
      data: [{
        id: 'file-1',
        name: 'Planning',
        created_at: 1_700_000_000_000,
        duration: 12_000,
        serial_number: 'must-not-leak',
      }],
    }));
    expect(recordings).toEqual([{
      id: 'file-1',
      title: 'Planning',
      recordedAt: new Date(1_700_000_000_000).toISOString(),
      durationMs: 12_000,
    }]);
    expect(JSON.stringify(recordings)).not.toContain('serial');
  });

  it('follows opaque transcript cursors and preserves segment evidence', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(transcriptPage(0, [{ content: 'First', start_time: 10 }], 'next'))
      .mockResolvedValueOnce(transcriptPage(1, [{ content: 'Second', start_time: 20 }], null));
    const source = await fetchPlaudTranscriptSource(
      { id: 'file-1', title: 'Planning', recordedAt: '2026-08-14T00:00:00.000Z' },
      call,
    );
    expect(call).toHaveBeenNthCalledWith(2, 'get_transcript', expect.objectContaining({ cursor: 'next' }));
    expect(source.segments).toEqual([
      { index: 0, content: 'First', startMs: 10 },
      { index: 1, content: 'Second', startMs: 20 },
    ]);
  });

  it('rejects cursor loops and oversized transcripts instead of truncating', async () => {
    const loop = vi.fn().mockResolvedValue(transcriptPage(0, [{ content: 'x' }], 'same'));
    await expect(
      fetchPlaudTranscriptSource(
        { id: 'file-1', title: 'Planning', recordedAt: '2026-08-14T00:00:00.000Z' },
        loop,
      ),
    ).rejects.toThrow(/repeated a cursor/);

    const oversized = vi.fn().mockResolvedValue(
      transcriptPage(0, [{ content: 'x'.repeat(PLAUD_MAX_TRANSCRIPT_CHARS + 1) }], null),
    );
    await expect(
      fetchPlaudTranscriptSource(
        { id: 'file-2', title: 'Long', recordedAt: '2026-08-14T00:00:00.000Z' },
        oversized,
      ),
    ).rejects.toBeInstanceOf(PlaudTranscriptTooLargeError);
  });
});

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

describe('PLAUD MCP retry and backoff', () => {
  const ok = (id: number) =>
    new Response(toolResponse(id, '{"data":[]}'), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const call = (fetchMock: FetchMock) =>
    callPlaudToolWithToken('token', 'list_files', { page: 1 }, fetchMock);

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a 429 and succeeds on a later attempt', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      const id = JSON.parse(String(init?.body)).id;
      return calls < 3 ? new Response('rate limited', { status: 429 }) : ok(id);
    });

    const promise = call(fetchMock);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('{"data":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries transient 5xx responses', async () => {
    for (const status of [500, 502, 503, 504, 408]) {
      let calls = 0;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        calls++;
        const id = JSON.parse(String(init?.body)).id;
        return calls === 1 ? new Response('nope', { status }) : ok(id);
      });

      const promise = call(fetchMock);
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe('{"data":[]}');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it('retries a thrown network failure', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      if (calls === 1) throw new TypeError('Network request failed');
      return ok(JSON.parse(String(init?.body)).id);
    });

    const promise = call(fetchMock);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('{"data":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 401 — the refresh path upstream owns it', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));

    const promise = call(fetchMock);
    const assertion = expect(promise).rejects.toMatchObject({ status: 401 });
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a caller error like 400', async () => {
    const fetchMock = vi.fn(async () => new Response('bad request', { status: 400 }));

    const promise = call(fetchMock);
    const assertion = expect(promise).rejects.toMatchObject({ status: 400 });
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt cap and rethrows the last error', async () => {
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }));

    const promise = call(fetchMock);
    const assertion = expect(promise).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a hung request that hit our own per-attempt deadline', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      const id = JSON.parse(String(init?.body)).id;
      if (calls === 1) {
        // Never settles on its own; the internal 30s timeout aborts it.
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abort = new Error('Aborted');
            abort.name = 'AbortError';
            reject(abort);
          });
        });
      }
      return ok(id);
    });

    const promise = call(fetchMock);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('{"data":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // A deterministic failure is one where the request DID produce a response we
  // could not use. Retrying sends an identical request and gets an identical
  // bad response, so it must cost exactly one call, not three.
  it.each([
    ['malformed body', 'not json at all'],
    [
      'a JSON-RPC protocol error',
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }),
    ],
    [
      'a tool-level rejection',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'boom' }], isError: true },
      }),
    ],
  ])('does NOT retry %s', async (_label, body) => {
    const fetchMock = vi.fn(
      async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const promise = call(fetchMock);
    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a response id that does not match the request', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(toolResponse(99_999, '{"data":[]}'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const promise = call(fetchMock);
    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After instead of guessing', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      const id = JSON.parse(String(init?.body)).id;
      return calls === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
        : ok(id);
    });

    const promise = call(fetchMock);

    // Not yet: the server asked for 2s, which is longer than our own backoff.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_500);
    await expect(promise).resolves.toBe('{"data":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps an absurd Retry-After rather than hanging the screen', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      const id = JSON.parse(String(init?.body)).id;
      return calls === 1
        ? new Response('later', { status: 503, headers: { 'retry-after': '86400' } })
        : ok(id);
    });

    const promise = call(fetchMock);
    await vi.advanceTimersByTimeAsync(11_000);

    await expect(promise).resolves.toBe('{"data":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('attemptTimeoutMs — the budget split that made retries reachable', () => {
  // The regression this covers: a fixed 30s per-attempt timeout meant a caller
  // with a shorter deadline (the import screen's ~12s) always aborted while
  // attempt 1 was still in flight, so the retry loop never ran once.
  it('fits every attempt plus its backoff inside a short caller budget', () => {
    const budget = 11_000;
    const first = attemptTimeoutMs(budget, 3);
    const second = attemptTimeoutMs(budget - first - 300, 2);
    const third = attemptTimeoutMs(budget - first - 300 - second - 800, 1);
    const spent = first + 300 + second + 800 + third;
    expect(spent).toBeLessThanOrEqual(budget);
    // and all three are real attempts, not degenerate slivers
    for (const t of [first, second, third]) expect(t).toBeGreaterThan(0);
  });

  it('never exceeds the per-attempt cap when the budget is generous', () => {
    expect(attemptTimeoutMs(10 * 60_000, 3)).toBeLessThanOrEqual(30_000);
  });

  it('gives the last attempt whatever is left, capped', () => {
    expect(attemptTimeoutMs(5_000, 1)).toBe(5_000);
    expect(attemptTimeoutMs(10 * 60_000, 1)).toBe(30_000);
  });

  it('reserves the backoff it still owes so waiting cannot starve attempting', () => {
    // With 3 attempts, 300 + 800 of backoff is still owed.
    const t = attemptTimeoutMs(3_500, 3);
    expect(t * 3 + 1_100).toBeLessThanOrEqual(3_500 + 3 * 2_000); // floor still applies
    expect(t).toBeGreaterThanOrEqual(0);
  });

  it('never returns a negative or NaN timeout for a spent budget', () => {
    for (const remaining of [0, -1, -50_000]) {
      for (const left of [1, 2, 3]) {
        const t = attemptTimeoutMs(remaining, left);
        expect(Number.isFinite(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('a spent deadline must not start a request', () => {
  // The P1 on #449: Math.max(MIN, budgetMs) clamped an already-expired budget
  // UP to the 2s minimum, so a caller whose deadline was gone still fired a
  // doomed authenticated call. Reachable twice per call via the 401 refresh.
  it.each([0, -1, -30_000])('rejects budget %ims without calling fetch', async (budget) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(
      callPlaudToolWithToken('token', 'list_files', { page: 1 }, fetchMock, budget),
    ).rejects.toBeInstanceOf(PlaudDeadlineError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([1, 500, 1_999, 2_000])(
    'still SENDS with only %ims left — positive time is time, and giving up early is not failing honestly',
    async (budget) => {
      const fetchMock = vi.fn(
        async (_u: string, init?: RequestInit) =>
          new Response(toolResponse(JSON.parse(String(init?.body)).id, '{"data":[]}'), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      await expect(
        callPlaudToolWithToken('token', 'list_files', { page: 1 }, fetchMock, budget),
      ).resolves.toBe('{"data":[]}');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('never hands back a timeout longer than the budget that produced it', () => {
    for (const remaining of [1, 250, 999, 1_500, 1_999, 2_000, 5_000, 60_000]) {
      for (const left of [1, 2, 3]) {
        expect(attemptTimeoutMs(remaining, left)).toBeLessThanOrEqual(remaining);
      }
    }
  });

  it('legacy: exactly the minimum viable attempt still runs', async () => {
    const fetchMock = vi.fn(
      async (_u: string, init?: RequestInit) =>
        new Response(toolResponse(JSON.parse(String(init?.body)).id, '{"data":[]}'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      callPlaudToolWithToken('token', 'list_files', { page: 1 }, fetchMock, 2_000),
    ).resolves.toBe('{"data":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
