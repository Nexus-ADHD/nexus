// NEX-328: pins hardSignOut's surgery-first design — bounded server revoke via
// plain fetch (a late-settling fetch touches no client state), then removal of
// all three SDK storage keys. auth-js 2.102 keeps no in-memory session, so
// storage surgery IS the sign-out. Mocks are injected; no network.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
    multiRemove: vi.fn(async () => {}),
  },
}));

vi.mock('../../utils/public-config', () => ({
  publicConfigValue: (key: string) =>
    key === 'EXPO_PUBLIC_SUPABASE_ANON_KEY'
      ? 'anon-test-key'
      : 'https://exampleref.supabase.co',
  publicConfigSource: () => 'extra',
}));

import {
  SUPABASE_AUTH_STORAGE_KEY,
  hardSignOut,
} from '../sign-out';

const KEY = 'sb-exampleref-auth-token';
const THREE_KEYS = [KEY, `${KEY}-code-verifier`, `${KEY}-user`];

function fakeStorage(seeded: Record<string, string>) {
  const map = new Map(Object.entries(seeded));
  return {
    map,
    getItem: vi.fn(async (k: string) => map.get(k) ?? null),
    getAllKeys: vi.fn(async () => [...map.keys()]),
    multiRemove: vi.fn(async (keys: string[]) => {
      for (const k of keys) map.delete(k);
    }),
  };
}

const seededSession = {
  [KEY]: JSON.stringify({ access_token: 'tok-123', refresh_token: 'ref-1' }),
  [`${KEY}-code-verifier`]: 'pkce',
  [`${KEY}-user`]: '{"id":"u"}',
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SUPABASE_AUTH_STORAGE_KEY', () => {
  it('derives sb-<project-ref>-auth-token like the SDK does', () => {
    expect(SUPABASE_AUTH_STORAGE_KEY).toBe(KEY);
  });
});

describe('hardSignOut', () => {
  it('revokes on the server with the stored token, then removes all three SDK keys', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = fakeStorage(seededSession);
    const result = await hardSignOut(storage);
    expect(result.persistedSessionCleared).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://exampleref.supabase.co/auth/v1/logout?scope=global');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    expect((init.headers as Record<string, string>).apikey).toBe('anon-test-key');
    expect(storage.multiRemove).toHaveBeenCalledWith(THREE_KEYS);
    expect(storage.map.size).toBe(0);
  });

  it('no persisted session: skips the server call, surgery still runs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const storage = fakeStorage({});
    const result = await hardSignOut(storage);
    expect(result.persistedSessionCleared).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.multiRemove).toHaveBeenCalledWith(THREE_KEYS);
  });

  it('malformed blob: no token to revoke, surgery still signs out', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const storage = fakeStorage({ [KEY]: 'not-json{' });
    const result = await hardSignOut(storage);
    expect(result.persistedSessionCleared).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.multiRemove).toHaveBeenCalledWith(THREE_KEYS);
  });

  it('offline (fetch throws): revoke is skipped, local sign-out still completes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const storage = fakeStorage(seededSession);
    const result = await hardSignOut(storage);
    expect(result.persistedSessionCleared).toBe(true);
    expect(storage.map.size).toBe(0);
  });

  it('a hung GoTrue never blocks the local sign-out (revoke is detached)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const storage = fakeStorage(seededSession);
    // Resolves immediately — no timer advance needed — even though the
    // revoke fetch never settles.
    const result = await hardSignOut(storage);
    expect(result.persistedSessionCleared).toBe(true);
    expect(storage.map.size).toBe(0);
  });

  // Greptile round 5: surgery must precede the revoke, so a session written
  // while the revoke is in flight is never deleted by it.
  it('a replacement session written during the revoke is never touched', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolveFetch = r; })));
    const storage = fakeStorage(seededSession);
    const result = await hardSignOut(storage);
    expect(result.persistedSessionCleared).toBe(true);
    // User signs back in while the revoke is still in flight.
    storage.map.set(KEY, JSON.stringify({ access_token: 'tok-NEW' }));
    resolveFetch(new Response('{}'));
    await new Promise((r) => setImmediate(r));
    expect(storage.map.get(KEY)).toContain('tok-NEW');
  });

  it('reports failure if the storage surgery itself throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const storage = fakeStorage(seededSession);
    storage.multiRemove.mockRejectedValueOnce(new Error('disk gone'));
    const result = await hardSignOut(storage);
    expect(result.persistedSessionCleared).toBe(false);
  });
});

// A cloud-sync baseline that OUTLIVES its session is a licence to write:
// sign out, sign back in, have the inbound restore fail silently, add one
// habit, and `cloud === seen` reads as "nothing changed" and authorises that
// near-empty state over a full cloud row.
describe('hardSignOut clears cloud-sync baselines', () => {
  const BASE = 'nexus.cloudSync.lastSeenUpdatedAt.';

  it('removes every per-user baseline alongside the session keys', async () => {
    const storage = fakeStorage({
      [KEY]: JSON.stringify({ access_token: '' }),
      [`${BASE}user-a`]: '2026-08-27T00:00:00.000Z',
      [`${BASE}user-b`]: '2026-08-26T00:00:00.000Z',
      'nexus_unrelated_key': 'keep me',
    });

    await hardSignOut(storage as any);

    expect(storage.map.has(`${BASE}user-a`)).toBe(false);
    expect(storage.map.has(`${BASE}user-b`)).toBe(false);
    // untouched: only baselines and session keys are swept
    expect(storage.map.get('nexus_unrelated_key')).toBe('keep me');
  });

  it('still signs out when the storage cannot enumerate keys', async () => {
    const storage = fakeStorage({ [KEY]: JSON.stringify({ access_token: '' }) });
    delete (storage as any).getAllKeys;

    const result = await hardSignOut(storage as any);

    expect(result.persistedSessionCleared).toBe(true);
    expect(storage.map.has(KEY)).toBe(false);
  });

  it('a failing key sweep never fails the sign-out', async () => {
    const storage = fakeStorage({ [KEY]: JSON.stringify({ access_token: '' }) });
    storage.getAllKeys = vi.fn(async () => {
      throw new Error('storage unavailable');
    }) as any;

    const result = await hardSignOut(storage as any);

    expect(result.persistedSessionCleared).toBe(true);
  });
});

describe('hardSignOut clears the AI session token cache', () => {
  it('a token cached for the previous person is gone before the next one signs in', async () => {
    const { aiSessionGeneration, rememberAccessToken, lastKnownAccessTokenOrNull } = await import('../../utils/ai-session-cache');
    rememberAccessToken('jwt-of-person-A', aiSessionGeneration());
    expect(lastKnownAccessTokenOrNull()).toBe('jwt-of-person-A');
    await hardSignOut({ getItem: async () => null, removeItem: async () => {}, getAllKeys: async () => [], multiRemove: async () => {} } as any);
    expect(lastKnownAccessTokenOrNull()).toBeNull();
  });
});


describe('hardSignOut synchronously invalidates sync', () => {
  it('stops the owner before the first asynchronous storage read', async () => {
    const { beginSyncSession } = await import('../sync-session');
    const session = beginSyncSession('owner-A');
    const storage = fakeStorage({});
    storage.getItem.mockImplementation(async () => {
      expect(session.isCurrent()).toBe(false);
      return null;
    });
    const signingOut = hardSignOut(storage);
    expect(session.isCurrent()).toBe(false);
    expect((await signingOut).persistedSessionCleared).toBe(true);
  });
});
