// NEX-124: unit tests for the PostHog conversion-funnel emitter + backfill in
// src/services/analytics.ts. Pure-Node (vitest config refuses the RN bundle), so
// the app-state set-once guards and the live category whitelist in
// commitActivation/addPillarManual are covered by the on-device manual test, not
// here. What IS unit-tested: dual-write forwarding, the pre-client queue/drain,
// and the consent-grant backfill (name whitelist, prop whitelist, original
// timestamp + deterministic uuid, run-once).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { storage.delete(key); }),
  },
}));

// analytics.ts imports ./supabase (drags native config) — stub it.
vi.mock('../supabase', () => ({ supabase: { auth: { getUser: vi.fn() }, from: vi.fn() } }));

const KEY_EVENT_LOG = 'nexus_analytics_log_v1';
// NEX-222 bumped v1 → v2 (item_captured); NEX-234 bumped v2 → v3 so paywall_dismissed
// replays for installs that finished the v2 backfill; NEX-215 bumped v3 → v4 so
// captured_item_first_reached replays for installs that finished the v3 backfill;
// NEX-299 bumped v4 → v5 so onboarding_step_completed (previously ZERO entry —
// entirely excluded from replay, not just stripped) replays for installs that
// finished the v4 backfill; NEX-301 bumped v5 → v6 so trial_nudge_scheduled/
// trial_nudge_tapped (same pre-consent-instant reasoning as subscription_started)
// replay for installs that finished the v5 backfill.
const KEY_BACKFILL_DONE = 'nexus_posthog_backfill_done_v6';
const KEY_BACKFILL_DONE_V4 = 'nexus_posthog_backfill_done_v4';
const KEY_BACKFILL_DONE_V5 = 'nexus_posthog_backfill_done_v5';

type Captured = { name: string; props?: any; options?: any };
function makeClient() {
  const calls: Captured[] = [];
  return {
    calls,
    capture: (name: string, props?: any, options?: any) => { calls.push({ name, props, options }); },
    flush: vi.fn(async () => {}),
  };
}

// Fresh module instance per test so module-level client/queue/guard state resets.
async function freshModule() {
  vi.resetModules();
  return import('../analytics');
}

beforeEach(() => {
  storage.clear();
  vi.clearAllMocks();
});

describe('NEX-124 PostHog forwarding', () => {
  it('forwards trackEvent to an installed client with the same name + props', async () => {
    const mod = await freshModule();
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.trackEvent('paywall_viewed', { entry_point: 'launch_gate', offerings_loaded: true });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].name).toBe('paywall_viewed');
    expect(client.calls[0].props).toEqual({ entry_point: 'launch_gate', offerings_loaded: true });
  });

  it('forwards live with the SAME deterministic uuid the backfill uses, so the two paths dedupe', async () => {
    const mod = await freshModule();
    const client = makeClient();
    mod.setPostHogClient(client as any);

    // Live forward.
    await mod.trackEvent('paywall_viewed', { entry_point: 'launch_gate', offerings_loaded: true });
    const liveUuid = client.calls[0].options?.uuid;
    const liveTs = (client.calls[0].options?.timestamp as Date)?.getTime();
    expect(typeof liveUuid).toBe('string');
    expect(typeof liveTs).toBe('number');

    // Same event row replayed by the backfill must carry the identical uuid.
    storage.set(KEY_EVENT_LOG, JSON.stringify([
      { name: 'paywall_viewed', ts: liveTs, props: { entry_point: 'launch_gate', offerings_loaded: true } },
    ]));
    await mod.backfillFunnelEventsToPostHog();

    const backfillCall = client.calls[1];
    expect(backfillCall.options.uuid).toBe(liveUuid); // dedupes in PostHog
  });

  it('NEX-222: same-ms item_captured siblings get distinct uuids, and live↔backfill still match per capture_id', async () => {
    const mod = await freshModule();
    const client = makeClient();
    mod.setPostHogClient(client as any);

    // Force both captures to the SAME ms — the exact collision case (one command,
    // two entities). A name|ts seed would give them identical uuids; capture_id
    // in the seed keeps them distinct.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      await mod.trackEvent('item_captured', { capture_id: 'A', item_type: 'one_off', capture_surface: 'inbox', local_day_key: '2026-06-17' });
      await mod.trackEvent('item_captured', { capture_id: 'B', item_type: 'habit', capture_surface: 'home_today', local_day_key: '2026-06-17' });
    } finally {
      nowSpy.mockRestore();
    }
    const uuidA = client.calls[0].options.uuid;
    const uuidB = client.calls[1].options.uuid;
    expect(uuidA).not.toBe(uuidB);

    // Backfill replay of the same rows reproduces the SAME per-capture uuids (dedupe holds).
    storage.set(KEY_EVENT_LOG, JSON.stringify([
      { name: 'item_captured', ts: 1000, props: { capture_id: 'A', item_type: 'one_off', capture_surface: 'inbox', local_day_key: '2026-06-17' } },
      { name: 'item_captured', ts: 1000, props: { capture_id: 'B', item_type: 'habit', capture_surface: 'home_today', local_day_key: '2026-06-17' } },
    ]));
    await mod.backfillFunnelEventsToPostHog();

    const backfillUuids = client.calls.slice(2).map((c) => ({ id: c.props.capture_id, uuid: c.options.uuid }));
    expect(backfillUuids).toContainEqual({ id: 'A', uuid: uuidA });
    expect(backfillUuids).toContainEqual({ id: 'B', uuid: uuidB });
  });

  it('NEX-215: captured_item_first_reached collapses re-reaches of one capture to a single uuid, and live↔backfill match', async () => {
    const mod = await freshModule();
    const client = makeClient();
    mod.setPostHogClient(client as any);

    // Two reaches of the SAME capture at DIFFERENT timestamps (echo chip now,
    // ledger jump later / a different session). The name|capture_id seed (NO ts)
    // must give them the SAME uuid so PostHog keeps one row per capture.
    const t1 = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await mod.trackEvent('captured_item_first_reached', { capture_id: 'X', item_type: 'one_off', surface: 'inbox', access_method: 'home_echo', age_bucket: 'under_1m' });
    t1.mockReturnValue(5000);
    await mod.trackEvent('captured_item_first_reached', { capture_id: 'X', item_type: 'one_off', surface: 'inbox', access_method: 'confirmation_jump', age_bucket: 'under_1h' });
    t1.mockRestore();

    const uuid1 = client.calls[0].options.uuid;
    const uuid2 = client.calls[1].options.uuid;
    expect(uuid1).toBe(uuid2); // collapses to one capture row regardless of ts/props

    // A DIFFERENT capture must get a different uuid.
    await mod.trackEvent('captured_item_first_reached', { capture_id: 'Y', item_type: 'habit', surface: 'home_today', access_method: 'confirmation_jump' });
    expect(client.calls[2].options.uuid).not.toBe(uuid1);

    // Backfill replay (allow-listed keys only) reproduces the same per-capture uuid.
    storage.set(KEY_EVENT_LOG, JSON.stringify([
      { name: 'captured_item_first_reached', ts: 1000, props: { capture_id: 'X', item_type: 'one_off', surface: 'inbox', access_method: 'home_echo', age_bucket: 'under_1m' } },
    ]));
    await mod.backfillFunnelEventsToPostHog();
    const replay = client.calls[3];
    expect(replay.name).toBe('captured_item_first_reached');
    expect(replay.options.uuid).toBe(uuid1); // dedupes against the live forward
    // Sanitized to allow-listed keys only (no stray props leak on replay).
    expect(Object.keys(replay.props).sort()).toEqual(['access_method', 'age_bucket', 'capture_id', 'item_type', 'surface']);
  });

  it('does not throw with no client, and drains queued forwards once a client is set', async () => {
    const mod = await freshModule();

    // No client yet — must not throw, must not lose the event.
    await mod.trackEvent('subscription_started', { period_type: 'trial', plan: 'annual', product_id: 'Annual' });

    const client = makeClient();
    mod.setPostHogClient(client as any); // drains

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].name).toBe('subscription_started');
    expect(client.calls[0].props.period_type).toBe('trial');
  });
});

describe('NEX-124 consent-grant backfill', () => {
  async function seedLog(events: { name: string; ts: number; props: any }[]) {
    storage.set(KEY_EVENT_LOG, JSON.stringify(events));
  }

  it('replays only whitelisted event names, sorted by original timestamp with a Date timestamp', async () => {
    const mod = await freshModule();
    await seedLog([
      { name: 'first_mandate_committed', ts: 2000, props: { mandate_count: 2, categories: 'business,vision', source: 'onboarding' } },
      { name: 'some_internal_event', ts: 1500, props: { secret: 'should-not-replay' } }, // not whitelisted
      { name: 'paywall_viewed', ts: 1000, props: { entry_point: 'launch_gate', offerings_loaded: true } },
    ]);
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.backfillFunnelEventsToPostHog();

    // Non-whitelisted name dropped; whitelisted replayed oldest-first.
    expect(client.calls.map((c) => c.name)).toEqual(['paywall_viewed', 'first_mandate_committed']);
    const first = client.calls[0];
    expect(first.options.timestamp).toBeInstanceOf(Date);
    expect(first.options.timestamp.getTime()).toBe(1000);
    expect(typeof first.options.uuid).toBe('string');
    expect(first.options.uuid.length).toBeGreaterThan(0);
  });

  it('re-normalizes the category whitelist on replay (unknown → other) and never spreads unknown prop keys', async () => {
    const mod = await freshModule();
    await seedLog([
      { name: 'first_mandate_committed', ts: 1, props: { mandate_count: 1, categories: 'business,wealth', source: 'manual', leaked_text: 'PII' } },
    ]);
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.backfillFunnelEventsToPostHog();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].props.categories).toBe('business,other');
    // Only whitelisted keys survive — a stray prop is dropped.
    expect(client.calls[0].props).not.toHaveProperty('leaked_text');
    expect(Object.keys(client.calls[0].props).sort()).toEqual(['categories', 'mandate_count', 'source']);
  });

  it('NEX-234: replays paywall_dismissed, keeping only entry_point (stray props dropped)', async () => {
    const mod = await freshModule();
    await seedLog([
      { name: 'paywall_dismissed', ts: 100, props: { entry_point: 'launch_gate', leaked: 'PII' } },
    ]);
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.backfillFunnelEventsToPostHog();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].name).toBe('paywall_dismissed');
    expect(client.calls[0].props).toEqual({ entry_point: 'launch_gate' });
  });

  it('runs once — a second invocation does not re-capture and sets the done flag', async () => {
    const mod = await freshModule();
    await seedLog([{ name: 'onboarding_finished', ts: 5, props: { mandates: 3, habits: 2, todos: 1, ringTint: 'teal' } }]);
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.backfillFunnelEventsToPostHog();
    expect(client.calls).toHaveLength(1);
    expect(storage.get(KEY_BACKFILL_DONE)).toBe('1');

    await mod.backfillFunnelEventsToPostHog();
    expect(client.calls).toHaveLength(1); // unchanged
  });

  it('no-ops when no client is installed (retries on a later tick)', async () => {
    const mod = await freshModule();
    await seedLog([{ name: 'paywall_viewed', ts: 1, props: { entry_point: 'settings', offerings_loaded: false } }]);

    await mod.backfillFunnelEventsToPostHog(); // no client set

    expect(storage.get(KEY_BACKFILL_DONE)).toBeUndefined();
  });

  // NEX-299 S1: onboarding_step_completed had NO BACKFILL_PROP_KEYS entry at
  // all before this — the backfill's event-name filter excluded it entirely,
  // not just stripped its props. Confirm it now replays with the new timing
  // props preserved alongside the existing phase/step/key.
  it('NEX-299 S1: replays onboarding_step_completed, preserving phase/step/key + the new timing props', async () => {
    const mod = await freshModule();
    await seedLog([
      {
        name: 'onboarding_step_completed',
        ts: 10,
        props: {
          phase: 'setup', step: 'first_win', key: 'captured',
          seconds_since_onboarding_start: 42, backgrounded_during_onboarding: false,
        },
      },
    ]);
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.backfillFunnelEventsToPostHog();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].name).toBe('onboarding_step_completed');
    expect(client.calls[0].props).toEqual({
      phase: 'setup', step: 'first_win', key: 'captured',
      seconds_since_onboarding_start: 42, backgrounded_during_onboarding: false,
    });
  });

  // NEX-299 S2: the allow-list stays a STRICT allow-list — an event whose
  // name IS listed still only survives replay with its allowed props; an
  // extra unlisted prop is dropped, not passed through. Same event name as
  // S1 (a synthetic/unlisted event name would be caught by the event-NAME
  // filter instead, which doesn't test prop stripping at all).
  it('NEX-299 S2: onboarding_step_completed replays but strips an unlisted extra prop', async () => {
    const mod = await freshModule();
    await seedLog([
      {
        name: 'onboarding_step_completed',
        ts: 10,
        props: { phase: 'setup', step: 'first_win', key: 'fallback_text', leaked_text: 'PII' },
      },
    ]);
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.backfillFunnelEventsToPostHog();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].props).not.toHaveProperty('leaked_text');
    expect(Object.keys(client.calls[0].props).sort()).toEqual(['key', 'phase', 'step']);
  });

  // NEX-299 S3: onboarding_finished's EXISTING allow-list entry gains the two
  // new timing props — confirm they survive alongside the pre-existing ones.
  it('NEX-299 S3: onboarding_finished replays with the new timing props alongside the existing ones', async () => {
    const mod = await freshModule();
    await seedLog([
      {
        name: 'onboarding_finished',
        ts: 5,
        props: {
          mandates: 3, habits: 2, todos: 1, ringTint: 'teal',
          seconds_since_onboarding_start: 180, backgrounded_during_onboarding: true,
        },
      },
    ]);
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.backfillFunnelEventsToPostHog();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].props).toEqual({
      mandates: 3, habits: 2, todos: 1, ringTint: 'teal',
      seconds_since_onboarding_start: 180, backgrounded_during_onboarding: true,
    });
  });

  // NEX-299 S4: an install that already finished the v4 backfill (old flag
  // set, new v5 flag unset) must get a one-time re-pass rather than being
  // skipped — this is what makes onboarding_step_completed actually reach
  // PostHog for existing beta installs, not just new ones.
  it('NEX-299 S4: a stale v4-only done flag does not block the v5 re-pass, and v5 gets set', async () => {
    const mod = await freshModule();
    storage.set(KEY_BACKFILL_DONE_V4, '1'); // finished v4; v5 (KEY_BACKFILL_DONE) is unset
    await seedLog([
      { name: 'onboarding_step_completed', ts: 1, props: { phase: 'inspire', step: 0, total: 3 } },
    ]);
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.backfillFunnelEventsToPostHog();

    expect(client.calls).toHaveLength(1);
    expect(storage.get(KEY_BACKFILL_DONE)).toBe('1');
  });

  // NEX-301 S12/S13: trial_nudge_scheduled/trial_nudge_tapped fire at the same
  // pre-consent purchase instant as subscription_started (the consent sheet
  // can't mount until AFTER a purchase — see analytics-consent-sheet.tsx's
  // appVisible gate), so both need BACKFILL_PROP_KEYS coverage, same as
  // subscription_started already has.
  it('NEX-301 S12: replays trial_nudge_scheduled with day/identifier preserved', async () => {
    const mod = await freshModule();
    await seedLog([
      { name: 'trial_nudge_scheduled', ts: 1, props: { day: 0, identifier: 'nexus-trial-nudge-day0' } },
    ]);
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.backfillFunnelEventsToPostHog();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].name).toBe('trial_nudge_scheduled');
    expect(client.calls[0].props).toEqual({ day: 0, identifier: 'nexus-trial-nudge-day0' });
  });

  it('NEX-301 S13: replays trial_nudge_tapped with day/identifier preserved', async () => {
    const mod = await freshModule();
    await seedLog([
      { name: 'trial_nudge_tapped', ts: 1, props: { day: 1, identifier: 'nexus-trial-nudge-day1' } },
    ]);
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.backfillFunnelEventsToPostHog();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].props).toEqual({ day: 1, identifier: 'nexus-trial-nudge-day1' });
  });

  // NEX-301 S14: allow-list stays strict — an unlisted extra prop is dropped.
  it('NEX-301 S14: trial_nudge_scheduled replays but strips an unlisted extra prop', async () => {
    const mod = await freshModule();
    await seedLog([
      { name: 'trial_nudge_scheduled', ts: 1, props: { day: 0, identifier: 'nexus-trial-nudge-day0', leaked: 'PII' } },
    ]);
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.backfillFunnelEventsToPostHog();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].props).not.toHaveProperty('leaked');
    expect(Object.keys(client.calls[0].props).sort()).toEqual(['day', 'identifier']);
  });

  // NEX-301 S15: an install that already finished the v5 backfill (old flag
  // set, new v6 flag unset) must get a one-time re-pass rather than being
  // skipped — makes trial_nudge_scheduled/tapped actually reach PostHog for
  // existing installs, not just new ones.
  it('NEX-301 S15: a stale v5-only done flag does not block the v6 re-pass, and v6 gets set', async () => {
    const mod = await freshModule();
    storage.set(KEY_BACKFILL_DONE_V5, '1'); // finished v5; v6 (KEY_BACKFILL_DONE) is unset
    await seedLog([
      { name: 'trial_nudge_scheduled', ts: 1, props: { day: 0, identifier: 'nexus-trial-nudge-day0' } },
    ]);
    const client = makeClient();
    mod.setPostHogClient(client as any);

    await mod.backfillFunnelEventsToPostHog();

    expect(client.calls).toHaveLength(1);
    expect(storage.get(KEY_BACKFILL_DONE)).toBe('1');
  });
});

// Dev onboarding-replay suppression: while a Settings-triggered replay is
// running, trackEvent must mute the local log AND the PostHog forward so
// replay-driven funnel events never pollute production metrics or the
// consent-grant backfill. Only __DEV__ builds can enable suppression.
describe('dev replay analytics suppression', () => {
  afterEach(() => {
    delete (globalThis as any).__DEV__;
  });

  it('suppresses trackEvent (log + forward) while enabled, resumes after', async () => {
    (globalThis as any).__DEV__ = true;
    const mod = await freshModule();
    const client = makeClient();
    mod.setPostHogClient(client as any);

    mod.setAnalyticsReplaySuppressed(true);
    await mod.trackEvent('onboarding_finished', {});
    expect(client.calls).toHaveLength(0);
    expect(storage.get(KEY_EVENT_LOG)).toBeUndefined();

    mod.setAnalyticsReplaySuppressed(false);
    await mod.trackEvent('onboarding_finished', {});
    expect(client.calls).toHaveLength(1);
  });

  it('is inert outside __DEV__ (release semantics)', async () => {
    (globalThis as any).__DEV__ = false;
    const mod = await freshModule();
    const client = makeClient();
    mod.setPostHogClient(client as any);

    mod.setAnalyticsReplaySuppressed(true); // must be a no-op
    await mod.trackEvent('paywall_viewed', { entry_point: 'settings', offerings_loaded: true });
    expect(client.calls).toHaveLength(1);
  });
});

describe('2026-10-11 audit fixes: no double-count, real install time', () => {
  const capturingClient = () => ({ ...makeClient(), disabled: false, optedOut: false });

  it('an event forwarded live while capture is enabled is marked sent and NOT replayed by a later backfill', async () => {
    const mod = await freshModule();
    const client = capturingClient();
    mod.setPostHogClient(client as any);
    await mod.trackEvent('paywall_viewed', { entry_point: 'launch_gate', offerings_loaded: true });
    expect(client.calls).toHaveLength(1);

    await mod.backfillFunnelEventsToPostHog();
    expect(client.calls).toHaveLength(1); // no second copy stamped with this version
    const log = JSON.parse(storage.get(KEY_EVENT_LOG)!);
    expect(log[0].sent).toBe(true);
  });

  it('a disabled (pre-consent) client does not mark sent, so the consent replay still delivers it', async () => {
    const mod = await freshModule();
    const client = { ...makeClient(), disabled: true, optedOut: false };
    mod.setPostHogClient(client as any);
    await mod.trackEvent('paywall_viewed', { entry_point: 'launch_gate', offerings_loaded: true });
    client.disabled = false;
    await mod.backfillFunnelEventsToPostHog();
    expect(client.calls.filter((c) => c.name === 'paywall_viewed').length).toBe(2); // swallowed live + replay
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget persist land
    expect(JSON.parse(storage.get(KEY_EVENT_LOG)!)[0].sent).toBe(true);
  });

  it('replayed events are marked sent so a later flag bump cannot re-send them', async () => {
    const mod = await freshModule();
    const client = capturingClient();
    storage.set(KEY_EVENT_LOG, JSON.stringify([{ name: 'paywall_dismissed', ts: 5, props: { entry_point: 'launch_gate' } }]));
    mod.setPostHogClient(client as any);
    await mod.backfillFunnelEventsToPostHog();
    expect(client.calls).toHaveLength(1);
    storage.delete(KEY_BACKFILL_DONE);
    await mod.backfillFunnelEventsToPostHog();
    expect(client.calls).toHaveLength(1);
  });

  it('activation_qualifying_day uses one uuid per calendar day regardless of when it fires', async () => {
    const mod = await freshModule();
    const client = capturingClient();
    mod.setPostHogClient(client as any);
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValue(1000);
    await mod.trackEvent('activation_qualifying_day', { dateKey: '2026-10-01' });
    spy.mockReturnValue(9_999_999);
    await mod.trackEvent('activation_qualifying_day', { dateKey: '2026-10-01' });
    spy.mockRestore();
    expect(client.calls[0].options.uuid).toBe(client.calls[1].options.uuid);
  });

  it('sends app_install_recorded once, at the recorded first-launch timestamp', async () => {
    const mod = await freshModule();
    const client = capturingClient();
    storage.set('nexus_first_launch_at_v1', '1700000000000');
    mod.setPostHogClient(client as any);
    await mod.sendInstallRecordedToPostHog();
    await mod.sendInstallRecordedToPostHog();
    const calls = client.calls.filter((c) => c.name === 'app_install_recorded');
    expect(calls).toHaveLength(1);
    expect((calls[0].options.timestamp as Date).getTime()).toBe(1700000000000);
  });

  it('does not send the install event while capture is disabled', async () => {
    const mod = await freshModule();
    const client = { ...makeClient(), disabled: true };
    mod.setPostHogClient(client as any);
    await mod.sendInstallRecordedToPostHog();
    expect(client.calls).toHaveLength(0);
  });
});
