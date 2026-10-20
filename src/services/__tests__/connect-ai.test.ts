// Unit tests for the Connect AI service (nexus-mcp client).
// expo-crypto and the supabase client are faked; fetch is stubbed per test.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({
  getRandomBytesAsync: vi.fn(async (n: number) => new Uint8Array(n).fill(0)),
  digestStringAsync: vi.fn(async (_alg: string, input: string) => `sha256-of-${input}`),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

const fake = vi.hoisted(() => ({
  insertResult: { error: null as null | { message: string } },
  inserts: [] as any[],
}));

vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => ({
      insert: (row: any) => {
        fake.inserts.push({ table, row });
        return Promise.resolve(fake.insertResult);
      },
    }),
  },
  getSession: vi.fn(async () => ({ access_token: 'user-jwt' })),
}));

import {
  MCP_SERVER_URL,
  generateCode,
  listConnections,
  mintConnectionCode,
  revokeConnection,
} from '../connect-ai';

beforeEach(() => {
  fake.inserts = [];
  fake.insertResult = { error: null };
  vi.unstubAllGlobals();
});

describe('generateCode', () => {
  it('mints an 8-char code from the unambiguous alphabet (worker CODE_PATTERN)', async () => {
    const code = await generateCode();
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(code).not.toMatch(/[OIL01]/);
  });
});

describe('mintConnectionCode', () => {
  it('stores ONLY the sha-256 hash, never the plaintext or an expires_at', async () => {
    const code = await mintConnectionCode('user-1');
    expect(fake.inserts).toHaveLength(1);
    const { table, row } = fake.inserts[0];
    expect(table).toBe('connect_codes');
    expect(row.user_id).toBe('user-1');
    expect(row.code_hash).toBe(`sha256-of-${code}`);
    // Only the hash leaves the device — no plaintext field, no expires_at
    // (the TTL is the server-side column default, never client-supplied).
    expect(Object.keys(row).sort()).toEqual(['code_hash', 'user_id']);
  });

  it('throws a readable error when the insert fails', async () => {
    fake.insertResult = { error: { message: 'rls denied' } };
    await expect(mintConnectionCode('user-1')).rejects.toThrow(/rls denied/);
  });
});

describe('connections', () => {
  it('lists connections with the user JWT against the worker', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ connections: [{ id: 'g1', client: 'ChatGPT', scope: ['diary'] }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const conns = await listConnections();
    expect(conns).toEqual([{ id: 'g1', client: 'ChatGPT', scope: ['diary'] }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://nexus-mcp.nexus-mcp.workers.dev/connections');
    expect(init.headers.Authorization).toBe('Bearer user-jwt');
  });

  it('revokes by grant id with the user JWT', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await revokeConnection('g1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string> }];
    expect(url).toContain('/connections?id=g1');
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe('Bearer user-jwt');
  });

  it('surfaces a non-ok revoke as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(revokeConnection('g1')).rejects.toThrow(/500/);
  });
});
