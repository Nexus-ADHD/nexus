// Tests for the dev-only "Skip sign-in" session flag. The module is
// pure (no RN imports), so it runs under the pure-Node vitest config.
// __DEV__ is a Metro global; vitest has no define for it, so each test
// controls it via globalThis and re-imports the module fresh.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const g = globalThis as any;

async function freshImport() {
  // resetModules in beforeEach guarantees this returns a NEW module
  // instance per test, with its initial `active = false` state, evaluated
  // under the test's own __DEV__ value.
  const mod = await import('../dev-skip-session');
  return mod;
}

describe('dev-skip-session', () => {
  beforeEach(() => {
    vi.resetModules();
    delete g.__DEV__;
  });

  afterEach(() => {
    delete g.__DEV__;
  });

  it('is inactive by default', async () => {
    const { isDevSkipSessionActive } = await freshImport();
    expect(isDevSkipSessionActive()).toBe(false);
  });

  it('activates via mark when __DEV__ is true', async () => {
    g.__DEV__ = true;
    const { markDevSkipSession, isDevSkipSessionActive } = await freshImport();
    markDevSkipSession();
    expect(isDevSkipSessionActive()).toBe(true);
  });

  it('clear deactivates an active session', async () => {
    g.__DEV__ = true;
    const { markDevSkipSession, clearDevSkipSession, isDevSkipSessionActive } =
      await freshImport();
    markDevSkipSession();
    clearDevSkipSession();
    expect(isDevSkipSessionActive()).toBe(false);
  });

  it('mark is a no-op when __DEV__ is false (release shape)', async () => {
    g.__DEV__ = false;
    const { markDevSkipSession, isDevSkipSessionActive } = await freshImport();
    markDevSkipSession();
    expect(isDevSkipSessionActive()).toBe(false);
  });

  it('mark is a no-op when __DEV__ is undefined (pure Node)', async () => {
    const { markDevSkipSession, isDevSkipSessionActive } = await freshImport();
    markDevSkipSession();
    expect(isDevSkipSessionActive()).toBe(false);
  });
});
