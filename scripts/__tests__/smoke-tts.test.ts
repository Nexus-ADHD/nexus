import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('scripts/smoke-tts.mjs', 'utf8').replace(/^#![^\n]*\n/, '');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
type Result = { status?: number; type?: string; size?: number; provider?: string };

async function run(short: Result = {}, long: Result = {}, expectations: Record<string, string> = {}) {
  const exit = vi.fn();
  let calls = 0;
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/admin/users')) return new Response(JSON.stringify({ id: 'fake-user' }));
    if (url.includes('/token?')) return new Response(JSON.stringify({ access_token: 'fake' }));
    if (init?.method === 'DELETE') return new Response('{}');
    const r = calls++ === 0 ? short : long;
    return new Response(new Uint8Array(r.size ?? 128), {
      status: r.status ?? 200,
      headers: { 'Content-Type': r.type ?? 'audio/mpeg', 'X-Tts-Provider': r.provider ?? 'openai' },
    });
  });
  await new AsyncFunction('process', 'fetch', 'console', source)({ env: {
    SUPABASE_URL: 'https://test.invalid', SUPABASE_ANON_KEY: 'fake',
    SUPABASE_SERVICE_ROLE_KEY: 'fake', AI_PROXY_APP_TOKEN: 'fake', ...expectations,
  }, exit }, network, { log: vi.fn(), error: vi.fn() });
  expect(network).toHaveBeenLastCalledWith('https://test.invalid/auth/v1/admin/users/fake-user', expect.objectContaining({ method: 'DELETE' }));
  return exit.mock.calls.at(-1)?.[0];
}

describe('actual speech deployment smoke', () => {
  it('passes successful audio without optional expectations', async () => expect(await run()).toBe(0));
  it('fails two failed requests without optional expectations', async () => expect(await run({ status: 502 }, { status: 502 })).toBe(1));
  it.each(['short', 'long'])('rejects non-audio and tiny audio for %s', async (which) => {
    for (const bad of [{ type: 'application/json' }, { size: 0 }, { size: 63 }]) {
      expect(await run(which === 'short' ? bad : {}, which === 'long' ? bad : {})).toBe(1);
    }
  });
  it('allows an explicit long error while still requiring short audio', async () => {
    expect(await run({}, { status: 502 }, { SMOKE_EXPECT_LONG_STATUS: '502' })).toBe(0);
    expect(await run({ status: 502 }, { status: 502 }, { SMOKE_EXPECT_LONG_STATUS: '502' })).toBe(1);
    expect(await run({}, { status: 504 }, { SMOKE_EXPECT_LONG_STATUS: '502' })).toBe(1);
  });
  it('does not waive audio checks for an explicit 200 or provider expectation', async () => {
    expect(await run({}, { size: 1 }, { SMOKE_EXPECT_LONG_STATUS: '200' })).toBe(1);
    expect(await run({}, { status: 502 }, { SMOKE_EXPECT_LONG: 'openai', SMOKE_EXPECT_LONG_STATUS: '502' })).toBe(1);
    expect(await run({}, {}, { SMOKE_EXPECT_SHORT: 'elevenlabs' })).toBe(1);
  });
});
