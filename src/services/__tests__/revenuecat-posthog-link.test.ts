// NEX-297: unit tests for the RevenueCat ↔ PostHog identity link in
// src/services/revenuecat.ts (linkPostHogIdentity, wired into
// configureRevenueCat + identifyUser). Pure-Node (vitest config refuses the RN
// bundle), so react-native-purchases, react-native, and expo-device are all
// mocked. Follows the freshModule + vi.resetModules() convention from
// funnel-analytics.test.ts so module-level singleton state (isConfigured,
// posthogClient) resets between tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

// revenuecat.ts + analytics.ts both import ./supabase — stub it.
vi.mock('../supabase', () => ({ supabase: { auth: { getUser: vi.fn() }, from: vi.fn() } }));

vi.mock('../nexus-profiles', () => ({ onPurchase: vi.fn() }));

const purchasesMock = vi.hoisted(() => ({
  configure: vi.fn(),
  setAttributes: vi.fn(async () => {}),
  logIn: vi.fn(async () => ({ customerInfo: {} }) as any),
  enableAdServicesAttributionTokenCollection: vi.fn(async () => {}),
}));

vi.mock('react-native-purchases', () => ({
  default: purchasesMock,
  INTRO_ELIGIBILITY_STATUS: {},
}));

function makeFakeClient(distinctId: string | undefined) {
  return {
    capture: vi.fn(),
    flush: vi.fn(async () => {}),
    getDistinctId: vi.fn(() => distinctId as any),
  };
}

// Fresh module instances per test so module-level state (isConfigured on
// revenuecat, posthogClient on analytics) resets. __DEV__ and expo-device's
// isDevice both drive SIM_BYPASS, which is computed at revenuecat.ts's MODULE
// LOAD time — both must be set before the dynamic import.
//
// mockReset() (not mockClear()) on each fn — mockClear only wipes call
// history, not a mockRejectedValue/mockResolvedValueOnce configured by a
// PRIOR test, which would otherwise leak into this one. Defaults are
// re-established immediately after so most tests don't need their own setup.
async function freshModules(opts: { dev?: boolean; isDevice?: boolean } = {}) {
  vi.resetModules();
  purchasesMock.configure.mockReset();
  purchasesMock.setAttributes.mockReset().mockResolvedValue(undefined);
  purchasesMock.logIn.mockReset().mockResolvedValue({ customerInfo: {} } as any);
  purchasesMock.enableAdServicesAttributionTokenCollection.mockReset().mockResolvedValue(undefined);
  (globalThis as any).__DEV__ = opts.dev ?? false;
  vi.doMock('expo-device', () => ({ isDevice: opts.isDevice ?? true }));
  const analytics = await import('../analytics');
  const rc = await import('../revenuecat');
  return { rc, analytics };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete (globalThis as any).__DEV__;
});

describe('NEX-297 RevenueCat ↔ PostHog identity link', () => {
  it('configureRevenueCat sets $posthogUserId from the current PostHog distinct id', async () => {
    const { rc, analytics } = await freshModules();
    analytics.setPostHogClient(makeFakeClient('ph-anon-123') as any);

    await rc.configureRevenueCat();

    expect(purchasesMock.setAttributes).toHaveBeenCalledTimes(1);
    expect(purchasesMock.setAttributes).toHaveBeenCalledWith({ '$posthogUserId': 'ph-anon-123' });
  });

  it('identifyUser sets $posthogUserId to the passed userId, not the mocked distinct id (race-avoidance)', async () => {
    const { rc, analytics } = await freshModules();
    // Deliberately stale/anonymous distinct id — identifyUser must NOT use this.
    analytics.setPostHogClient(makeFakeClient('ph-anon-stale') as any);

    await rc.identifyUser('uid-1');

    expect(purchasesMock.logIn).toHaveBeenCalledTimes(1);
    expect(purchasesMock.logIn).toHaveBeenCalledWith('uid-1');
    expect(purchasesMock.setAttributes).toHaveBeenCalledTimes(1);
    expect(purchasesMock.setAttributes).toHaveBeenCalledWith({ '$posthogUserId': 'uid-1' });
  });

  it('identifyUser retries once on a failed logIn, then succeeds and links', async () => {
    const { rc, analytics } = await freshModules();
    analytics.setPostHogClient(makeFakeClient('ph-anon-123') as any);
    purchasesMock.logIn
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ customerInfo: {} } as any);

    await rc.identifyUser('uid-1');

    expect(purchasesMock.logIn).toHaveBeenCalledTimes(2);
    expect(purchasesMock.setAttributes).toHaveBeenCalledTimes(1);
    expect(purchasesMock.setAttributes).toHaveBeenCalledWith({ '$posthogUserId': 'uid-1' });
  });

  it('identifyUser swallows a failure on both attempts without throwing or linking', async () => {
    const { rc, analytics } = await freshModules();
    analytics.setPostHogClient(makeFakeClient('ph-anon-123') as any);
    purchasesMock.logIn.mockRejectedValue(new Error('down'));

    await expect(rc.identifyUser('uid-1')).resolves.toBeUndefined();

    expect(purchasesMock.logIn).toHaveBeenCalledTimes(2);
    expect(purchasesMock.setAttributes).not.toHaveBeenCalled();
  });

  it('no-ops without throwing when no PostHog client is wired yet', async () => {
    const { rc } = await freshModules();
    // No setPostHogClient call — distinct id is unavailable.

    await rc.configureRevenueCat();

    expect(purchasesMock.configure).toHaveBeenCalledTimes(1);
    expect(purchasesMock.setAttributes).not.toHaveBeenCalled();
  });

  it('no-ops without an unhandled rejection when getDistinctId throws', async () => {
    const { rc, analytics } = await freshModules();
    analytics.setPostHogClient({
      capture: vi.fn(),
      getDistinctId: vi.fn(() => { throw new Error('boom'); }),
    } as any);

    await expect(rc.configureRevenueCat()).resolves.toBeUndefined();
    expect(purchasesMock.setAttributes).not.toHaveBeenCalled();
  });

  it('waits and retries once for a not-yet-initialized PostHog client, then links', async () => {
    const { rc, analytics } = await freshModules();
    // First read (synchronous, at RC configure time) returns empty — PostHog's
    // own async init (AsyncStorage bridge) hasn't resolved yet; the retried
    // read after the bounded wait succeeds.
    const getDistinctId = vi.fn().mockReturnValueOnce('').mockReturnValueOnce('ph-anon-ready');
    analytics.setPostHogClient({ capture: vi.fn(), getDistinctId } as any);

    // configureRevenueCat() does NOT await the fire-and-forget linkPostHogIdentity
    // call (by design, so it can't block the launch path) — wait for the
    // 300ms-bounded retry to actually complete before asserting.
    await rc.configureRevenueCat();
    await vi.waitFor(() => expect(purchasesMock.setAttributes).toHaveBeenCalledTimes(1), { timeout: 1000 });

    expect(getDistinctId).toHaveBeenCalledTimes(2);
    expect(purchasesMock.setAttributes).toHaveBeenCalledWith({ $posthogUserId: 'ph-anon-ready' });
  });

  it('does not clobber a real identity that bound while the anonymous-window retry was waiting', async () => {
    const { rc, analytics } = await freshModules();
    // First read (at configure time) is empty — the real-world default that
    // sends the anonymous-window call into its 300ms retry-wait; the retried
    // read resolves to a (still-anonymous, now-stale) distinct id.
    const getDistinctId = vi.fn().mockReturnValueOnce('').mockReturnValue('ph-anon-not-yet-identified');
    analytics.setPostHogClient({ capture: vi.fn(), getDistinctId } as any);

    void rc.configureRevenueCat(); // starts the anonymous-window 300ms retry-wait in the background
    await rc.identifyUser('uid-real'); // completes well within that 300ms window
    await vi.waitFor(() => expect(purchasesMock.setAttributes).toHaveBeenCalledWith({ $posthogUserId: 'uid-real' }), { timeout: 1000 });

    // Let the anonymous path's delayed retry finish and attempt its (stale) assert.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(purchasesMock.setAttributes).toHaveBeenCalledTimes(1);
    expect(purchasesMock.setAttributes).toHaveBeenCalledWith({ $posthogUserId: 'uid-real' });
  });

  it('does not call setAttributes when a newer identity has taken over mid-flight (isStale guard)', async () => {
    const { rc, analytics } = await freshModules();
    analytics.setPostHogClient(makeFakeClient('ph-anon-123') as any);
    // logIn succeeds, but by the time linkPostHogIdentity checks isStale()
    // (right before the native call) a newer account has taken over.
    const isStale = vi.fn(() => true);

    await rc.identifyUser('uid-1', isStale);
    // identifyUser doesn't await linkPostHogIdentity either — give the
    // fire-and-forget chain a beat to run before asserting the negative.
    await vi.waitFor(() => expect(isStale).toHaveBeenCalled(), { timeout: 1000 });

    expect(purchasesMock.logIn).toHaveBeenCalledWith('uid-1');
    expect(purchasesMock.setAttributes).not.toHaveBeenCalled();
  });

  it('still links when isStale reports NOT stale', async () => {
    const { rc, analytics } = await freshModules();
    analytics.setPostHogClient(makeFakeClient('ph-anon-123') as any);
    const isStale = vi.fn(() => false);

    await rc.identifyUser('uid-1', isStale);
    await vi.waitFor(() => expect(purchasesMock.setAttributes).toHaveBeenCalledTimes(1), { timeout: 1000 });

    expect(purchasesMock.setAttributes).toHaveBeenCalledWith({ $posthogUserId: 'uid-1' });
  });

  it('SIM_BYPASS: neither configure nor setAttributes fire in the simulator', async () => {
    const { rc, analytics } = await freshModules({ dev: true, isDevice: false });
    analytics.setPostHogClient(makeFakeClient('ph-anon-123') as any);

    await rc.configureRevenueCat();
    await rc.identifyUser('uid-1');

    expect(purchasesMock.configure).not.toHaveBeenCalled();
    expect(purchasesMock.logIn).not.toHaveBeenCalled();
    expect(purchasesMock.setAttributes).not.toHaveBeenCalled();
  });
});
