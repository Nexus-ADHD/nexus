// Guards the launch-crash class found in the build-178 incident: module-scope
// createClient('') throws "supabaseUrl is required." during bundle eval, which
// expo-updates ErrorRecovery converts into a SIGABRT before first render.
// The degraded (unconfigured) branch is unreachable on-device once the
// app.json extra fallback exists, so these tests are its ONLY coverage.
import { afterEach, describe, expect, it, vi } from 'vitest';

const extraHolder = vi.hoisted(() => ({ extra: {} as Record<string, unknown> }));

vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return { extra: extraHolder.extra };
    },
  },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));

const ENV_KEYS = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'] as const;

async function importSupabaseModule(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) {
      vi.stubEnv(key, '');
      delete process.env[key];
    } else {
      vi.stubEnv(key, env[key]!);
    }
  }
  return import('../supabase');
}

afterEach(() => {
  vi.unstubAllEnvs();
  extraHolder.extra = {};
  vi.restoreAllMocks();
});

describe('supabase module with no config anywhere', () => {
  it('imports without throwing and reports unconfigured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await importSupabaseModule({});
    expect(mod.isSupabaseConfigured()).toBe(false);
    expect(mod.supabase).toBeTruthy();
  });

  it('logs a degraded-mode error instead of crashing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await importSupabaseModule({});
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Supabase config missing'));
  });

  it('keeps the auth.onAuthStateChange destructure shape used by app/_layout.tsx', async () => {
    // The exact crash vector a throwing fallback would re-introduce:
    // `const { data: { subscription } } = supabase.auth.onAuthStateChange(...)`
    // runs bare (no try/catch) in a mount effect.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await importSupabaseModule({});
    const { data } = mod.supabase.auth.onAuthStateChange(() => {});
    expect(data.subscription).toBeTruthy();
    expect(() => data.subscription.unsubscribe()).not.toThrow();
  });

  it('resolves getSession without throwing synchronously', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await importSupabaseModule({});
    const session = await mod.getSession();
    expect(session).toBeNull();
  });
});

describe('supabase module config resolution', () => {
  it('is configured from env vars (build-time inline path)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const mod = await importSupabaseModule({
      EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      EXPO_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
    });
    expect(mod.isSupabaseConfigured()).toBe(true);
  });

  it('is configured from app.json extra when env is missing (Xcode archive path)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    extraHolder.extra = {
      EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      EXPO_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
    };
    const mod = await importSupabaseModule({});
    expect(mod.isSupabaseConfigured()).toBe(true);
  });
});
