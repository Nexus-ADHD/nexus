import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Execute the real Deno handler with only its external modules replaced.
// No server, Supabase account, API credentials, or network is used.
function harness(stall?: 'auth' | 'limiter', errorBody = false) {
  let handler!: (req: Request) => Promise<Response>;
  let stalledSignal: AbortSignal | undefined;
  const end = vi.fn();
  const log = vi.fn();
  const speech = vi.fn(async () => {
    if (errorBody) {
      return new Response(new ReadableStream({
        start(c) { c.error(new DOMException('deadline', 'TimeoutError')); },
      }), { status: 429 });
    }
    return new Response(new Uint8Array(128), { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const network = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.includes('/audio/speech')) return speech();
    if (input === stall) {
      stalledSignal = init?.signal ?? undefined;
      // Simulate a dependency that never resolves, even when aborted.
      return new Promise<Response>(() => {});
    }
    return new Response('{}');
  });
  const env: Record<string, string> = {
    OPENAI_API_KEY: 'test', AI_PROXY_APP_TOKEN: 'test',
    SUPABASE_URL: 'https://test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test',
    BRAINTRUST_API_KEY: 'test',
  };
  const cache = new Map<string, object>();
  function load(file: string): object {
    if (cache.has(file)) return cache.get(file)!;
    const exports = {};
    cache.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const requireMock = (id: string): object => {
      if (id.includes('/http/server.ts')) return { serve: (fn: typeof handler) => { handler = fn; } };
      if (id.includes('@supabase/supabase-js')) return {
        createClient: (_url: string, _key: string, options: { global?: { fetch: typeof network } }) => {
          const fetcher = options.global?.fetch ?? network;
          return {
            auth: { getUser: async () => {
              await fetcher('auth');
              return { data: { user: { id: 'test-user' } }, error: null };
            } },
            rpc: async () => {
              await fetcher('limiter');
              return { data: 1, error: null };
            },
          };
        },
      };
      if (id.startsWith('https://esm.sh/braintrust')) return {
        initLogger: () => ({ startSpan: () => ({ log, end }), flush: async () => {} }),
      };
      if (id.endsWith('/sentry.ts')) return { captureEdgeError: vi.fn() };
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
      throw new Error(`Unmocked dependency: ${id}`);
    };
    new Function('require', 'exports', 'Deno', 'fetch', code)(requireMock, exports, { env: { get: (key: string) => env[key] } }, network);
    return exports;
  }
  load(path.resolve('supabase/functions/ai-proxy/index.ts'));
  const request = () => handler(new Request('https://test.invalid/functions/v1/ai-proxy/tts', {
    method: 'POST',
    headers: { 'X-App-Token': 'test', Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Today, return.' }),
  }));
  return { request, speech, end, log, network, signal: () => stalledSignal };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('actual /tts handler', () => {
  for (const stage of ['auth', 'limiter'] as const) {
    it(`stops stalled ${stage} at 13 seconds without starting speech`, async () => {
      vi.useFakeTimers();
      const h = harness(stage);
      const pending = h.request();
      await vi.advanceTimersByTimeAsync(13_000);
      expect((await pending).status).toBe(504);
      expect(h.signal()?.aborted).toBe(true);
      expect(h.speech).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it('closes metrics once when an OpenAI error body aborts after headers', async () => {
    const h = harness(undefined, true);
    const response = await h.request();
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('Speech failed (429)');
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ status: 502, openai_status: 429 }) }));
  });

  it('returns audio with its provider header and closes metrics once', async () => {
    const h = harness();
    const response = await h.request();
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Tts-Provider')).toBe('openai');
    expect((await response.arrayBuffer()).byteLength).toBe(128);
    expect(h.end).toHaveBeenCalledTimes(1);
  });
});
