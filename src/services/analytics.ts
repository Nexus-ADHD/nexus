// Lightweight analytics layer for NEX-17.
//
// What this is: a small, local-first event log that the app can write to
// from anywhere without a network call. Events are kept in memory and
// persisted to AsyncStorage in batches so a crash doesn't lose them. A
// drain hook (`flush`) can be wired to Supabase or any external sink
// later — for now the events stay on-device and feed the baseline
// activation-rate readout for the first 50 users.
//
// Used by:
//  - app/_layout.tsx (onboarding step emission)
//  - src/services/activation-tracker.ts (activation_completed)
//  - any future surface that wants to record a milestone

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import {
  ITEM_CAPTURED_KEYS,
  CAPTURED_ITEM_FIRST_REACHED_KEYS,
  ageBucket,
  itemTypeForSurface,
  type AccessMethod,
} from './north-star-metrics';
import type { CaptureSurface } from '../features/command/confirmation-copy';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AnalyticsEventName =
  | 'onboarding_phase_started'
  | 'onboarding_phase_completed'
  | 'onboarding_step_completed'
  | 'onboarding_finished'
  | 'ring_tint_chosen'
  // NEX-120: the Moment 5 ceremonial finale was viewed (screen-view, split from
  // the onboarding_step_completed{step:4,key:'moment_5'} emitted on ENTER NEXUS).
  | 'moment_5_viewed'
  | 'activation_qualifying_day'
  | 'activation_completed'
  | 'trial_extension_offer_shown'
  | 'trial_extension_offer_accepted'
  | 'trial_extension_offer_declined'
  | 'trial_extension_granted'
  | 'trial_extension_grant_failed'
  // NEX-301: in-trial Day-0/1 activation nudge — fires at the same pre-consent
  // purchase instant as subscription_started (see BACKFILL_PROP_KEYS below).
  | 'trial_nudge_scheduled'
  | 'trial_nudge_tapped'
  // NEX-124 conversion-funnel events. All PII-free (counts/enums/IDs only).
  | 'paywall_viewed'
  // NEX-234: fired when the user dismisses a paywall (launch-gate "Not now" or
  // the settings X-close) instead of subscribing.
  | 'paywall_dismissed'
  // Free-week re-offer after the user's first win (see features/paywall/reoffer-logic.ts).
  | 'paywall_reoffer_shown'
  | 'paywall_reoffer_started'
  | 'subscription_started'
  | 'subscription_restored'
  | 'first_mandate_committed'
  | 'first_alignment_score_seen'
  // NEX-164: Day-1 activation signal — fired on habit completion. is_first
  // marks the user's first-ever completion (durable, from firstHabitCompletedAt).
  | 'habit_completed'
  // NEX-188: north-star metric contract (hunts→0 + return-after-lapse). Names
  // only — NO emitters yet, and intentionally NOT added to BACKFILL_PROP_KEYS
  // (the replay allow-list is an emitter-time decision; see the emitter ticket
  // and src/services/north-star-metrics.ts for the PII-free prop-key arrays).
  | 'item_captured'
  | 'captured_item_first_reached'
  | 'app_opened';

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  ts: number; // unix ms
  props: Record<string, string | number | boolean | null>;
  // True once this event reached PostHog (live forward while capture was enabled, or
  // the consent-grant replay). The replay skips sent events, so a backfill version
  // bump can no longer re-send everything stamped with the new app version.
  sent?: boolean;
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

const KEY_EVENT_LOG = 'nexus_analytics_log_v1';
const KEY_ACTIVATION_FIRED = 'nexus_activation_fired_at_v1';
const KEY_BASELINE_COHORT = 'nexus_baseline_cohort_v1';

// Ring buffer cap. The log is local-only — there's no need to keep more
// than the first ~500 events. Old entries roll off the front when we
// exceed the cap on write. The baseline computation reads from the
// persisted blob, so any data older than this is gone for good.
const MAX_EVENTS = 500;

// Soft cohort cap. The acceptance criterion is "baseline activation rate
// captured for first 50 users" — once we cross 50, we still record
// events but stop weighting them into the baseline.
const BASELINE_COHORT_SIZE = 50;

// NEX-124: marks that this install has replayed its pre-consent funnel events
// to PostHog (Approach C). Install-scoped, not user-scoped — it tracks whether
// THIS device's local log has been backfilled, so it is intentionally NOT
// cleared on sign-out (the local event log isn't cleared either).
//
// NEX-222: bumped v1 → v2 because `item_captured` joined the replay allow-list.
// Installs that finished the v1 backfill before this shipped would otherwise
// never replay their locally-logged pre-consent `item_captured` rows (the early
// return on the done flag). Bumping the key forces ONE more backfill pass per
// install; it is idempotent — every replayed event carries a deterministic
// `name|ts` UUID, so the already-sent funnel events dedupe in PostHog and only
// the genuinely-new rows actually land.
// NEX-234 bumped v2 → v3: adding `paywall_dismissed` to BACKFILL_PROP_KEYS does
// NOT replay it for installs that already finished the v2 backfill (run-once
// flag), so a one-time re-pass is forced. Idempotent: the deterministic UUID
// dedupes everything already sent, so only locally-logged `paywall_dismissed`
// rows land.
// NEX-215 bumped v3 → v4: same reasoning for adding `captured_item_first_reached`
// to BACKFILL_PROP_KEYS — installs that finished the v3 backfill need one more
// pass to replay locally-logged pre-consent reach rows. Idempotent (deterministic
// UUID seeded on `name|capture_id`).
// NEX-299 bumped v4 → v5: `onboarding_step_completed` had NO entry at all
// before this (every emission — first-win or otherwise — was silently
// excluded from replay, not just stripped of props, since the backfill
// filters by `e.name in BACKFILL_PROP_KEYS`). Adding the entry doesn't
// replay it for installs that already finished the v4 backfill, so the
// version bump forces the one-time re-pass. Idempotent (deterministic
// `name|ts` UUID).
// NEX-301 bumped v5 → v6: `trial_nudge_scheduled` fires at the same
// pre-consent purchase instant as `subscription_started` (the paywall
// completes, THEN the app becomes visible, THEN the consent sheet renders —
// see analytics-consent-sheet.tsx's appVisible gate), so it needs the same
// backfill treatment `subscription_started` already gets. `trial_nudge_tapped`
// fires later but is included too, for consistency and low incremental cost.
const KEY_POSTHOG_BACKFILL_DONE = 'nexus_posthog_backfill_done_v6';

// ─── PostHog forwarding (NEX-124) ─────────────────────────────────────────────
//
// trackEvent dual-writes: local ring buffer (above) + PostHog (here). Rather
// than scatter usePostHog().capture() through components, the PostHog client is
// injected once from RootLayoutInner via setPostHogClient() and every funnel
// event forwards through the single emitter.
//
// Consent: the PostHogProvider is constructed with `disabled: consent !==
// 'granted'`, and capture() early-returns while disabled — so forwarding here is
// a no-op until the user grants consent. Events that fire pre-consent are
// recovered by the consent-grant backfill (backfillFunnelEventsToPostHog).
//
// Hydration remount: the provider remounts once on hydration (key=ready/pre) and
// builds a new client; RootLayoutInner re-runs setPostHogClient on the [posthog]
// dependency. Events fired in the window BEFORE the first client is installed
// would otherwise be dropped even for an already-consented returning user — so
// we queue forwards while no client is set and drain them on install.

// Minimal shape we use — avoids coupling to posthog-react-native's export.
interface PostHogLike {
  capture: (
    name: string,
    props?: Record<string, unknown>,
    options?: { timestamp?: Date; uuid?: string },
  ) => void;
  flush?: () => Promise<void>;
  getDistinctId?: () => string;
}

let posthogClient: PostHogLike | null = null;
let pendingForwards: {
  name: AnalyticsEventName;
  props: AnalyticsEvent['props'];
  ts: number;
  event: AnalyticsEvent;
}[] = [];
const MAX_PENDING_FORWARDS = 100;

// Every forward — live, drained, and backfilled — carries the SAME deterministic
// uuid + original timestamp. This is what lets the live path and the consent-grant
// backfill (which replays the local log) dedupe in PostHog: an already-consented
// user whose event fires live AND gets replayed by the first-launch backfill would
// otherwise be double-counted (random uuid vs deterministic uuid).
//
// The seed is `${name}|${ts}` for funnel events (one per ts). NEX-222: `item_captured`
// can fire several times in ONE command at the same `Date.now()` ms, so a name|ts seed
// would give siblings identical UUIDs and PostHog would dedupe real captures away.
// Add the opaque `capture_id` for that event. The seed must be computed identically on
// both paths — live forwards `enriched.props` and backfill forwards `sanitizeReplayProps`
// (capture_id is in ITEM_CAPTURED_KEYS, so it survives sanitization) — so the live↔backfill
// dedupe still holds.
function eventUuidSeed(
  name: AnalyticsEventName,
  ts: number,
  props: AnalyticsEvent['props'],
): string {
  if (name === 'item_captured' && typeof props.capture_id === 'string') {
    return `${name}|${ts}|${props.capture_id}`;
  }
  // NEX-215: `captured_item_first_reached` should collapse to ONE row per
  // capture — re-reaches of the same item (different surfaces, different
  // sessions, different ts) must dedupe to the first-ingested. So its seed is
  // `name|capture_id` with NO ts (every reach of a capture shares it). PostHog's
  // uuid-dedup is best-effort across long gaps; the offline
  // `computeHuntFirstReachRate` join on capture_id is the durable first-per-
  // capture backstop (see north-star-metrics.ts). Name-qualified so it can't
  // collide with another event family's id.
  if (name === 'captured_item_first_reached' && typeof props.capture_id === 'string') {
    return `${name}|${props.capture_id}`;
  }
  // One row per qualifying calendar day per install; the tracker re-derives days on
  // every launch, so a ts-based seed would mint a new id (and a duplicate row) each time.
  if (name === 'activation_qualifying_day' && typeof props.dateKey === 'string') {
    return `${name}|${props.dateKey}`;
  }
  return `${name}|${ts}`;
}

// True only when the client will actually ingest: the SDK silently drops capture()
// while `disabled` (pre-consent) or opted out, and getFeatureFlag-style reads bypass
// that, so check both explicitly. Unknown => not sent (replay stays the safety net).
function clientIsCapturing(client: PostHogLike): boolean {
  const c = client as unknown as { disabled?: boolean; optedOut?: boolean };
  return c.disabled === false && c.optedOut !== true;
}

function forwardToPostHog(
  client: PostHogLike,
  name: AnalyticsEventName,
  props: AnalyticsEvent['props'],
  ts: number,
): void {
  try {
    client.capture(name, props, {
      timestamp: new Date(ts),
      uuid: deterministicUuid(eventUuidSeed(name, ts, props)),
    });
  } catch {}
}

export function setPostHogClient(client: PostHogLike | null): void {
  posthogClient = client;
  if (client && pendingForwards.length > 0) {
    const drain = pendingForwards;
    pendingForwards = [];
    const capturing = clientIsCapturing(client);
    for (const f of drain) {
      forwardToPostHog(client, f.name, f.props, f.ts);
      if (capturing) f.event.sent = true;
    }
    if (capturing) void persistEvents();
  }
}

// NEX-297: exposes the injected client's current distinct id so other services
// (RevenueCat's PostHog-link attribute) can read it without coupling to the
// posthog-react-native SDK directly. undefined while no client is wired yet.
export function getPostHogDistinctId(): string | undefined {
  return posthogClient?.getDistinctId?.();
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

let cachedEvents: AnalyticsEvent[] | null = null;
let writeLock: Promise<void> | null = null;

async function loadEvents(): Promise<AnalyticsEvent[]> {
  if (cachedEvents) return cachedEvents;
  try {
    const raw = await AsyncStorage.getItem(KEY_EVENT_LOG);
    cachedEvents = raw ? (JSON.parse(raw) as AnalyticsEvent[]) : [];
  } catch {
    cachedEvents = [];
  }
  return cachedEvents;
}

async function persistEvents(): Promise<void> {
  if (!cachedEvents) return;
  // Serialize writes so concurrent trackEvent calls don't race.
  const prev = writeLock;
  writeLock = (async () => {
    if (prev) await prev.catch(() => {});
    try {
      await AsyncStorage.setItem(KEY_EVENT_LOG, JSON.stringify(cachedEvents));
    } catch (e) {
      console.log('[analytics] persist failed:', (e as Error)?.message ?? e);
    }
  })();
  return writeLock;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Dev-only onboarding-replay suppression. While a replay is running
// (Settings → REPLAY ONBOARDING), every analytics path is muted: a replay
// on a consented real device would otherwise re-fire the onboarding
// conversion funnel into production PostHog, append to the local event
// log (which the consent backfill replays later), and insert into
// nexus_events. Module-level rather than reading app-state to avoid the
// app-state → analytics import cycle. Hard-false in release builds.
let replaySuppressed = false;
export function setAnalyticsReplaySuppressed(value: boolean): void {
  // typeof guard: bare __DEV__ throws in pure-Node vitest (no global define).
  const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
  replaySuppressed = isDev ? value : false;
}

export async function trackEvent(
  name: AnalyticsEventName,
  props: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  if (replaySuppressed) return;
  const events = await loadEvents();
  const enriched: AnalyticsEvent = {
    name,
    ts: Date.now(),
    props: { ...props },
  };
  events.push(enriched);
  // Roll off the head if we've blown past the cap.
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  cachedEvents = events;

  // NEX-124: forward to PostHog. No-op (silently) while disabled (pre-consent);
  // queued while no client is installed yet, then drained on setPostHogClient.
  // Deterministic uuid + timestamp so a live forward and a later backfill replay
  // of the same event dedupe instead of double-counting (see forwardToPostHog).
  if (posthogClient) {
    forwardToPostHog(posthogClient, name, enriched.props, enriched.ts);
    if (clientIsCapturing(posthogClient)) enriched.sent = true;
  } else {
    pendingForwards.push({ name, props: enriched.props, ts: enriched.ts, event: enriched });
    if (pendingForwards.length > MAX_PENDING_FORWARDS) pendingForwards.shift();
  }
  // Persist AFTER the forward so the `sent` flag lands in the same write.
  // Fire-and-forget — callers don't need to await.
  void persistEvents();
}

// ─── Consent-grant backfill (NEX-124, Approach C) ─────────────────────────────
//
// All client funnel events fire pre-consent and PostHog drops them. On consent
// grant we replay the funnel/activation events from the local log so the funnel
// has data to begin with. Whitelisted by name AND by prop key — never spread
// stored props verbatim, so a future event that accidentally carries PII can't
// leak through replay. Each replayed event keeps its ORIGINAL timestamp and a
// deterministic UUID, so a re-run (crash before the done-flag persists) does not
// duplicate — PostHog dedupes on uuid.

// Per-event allow-list of prop KEYS. Only these keys are replayed; anything else
// (including any accidental future PII prop) is dropped.
const BACKFILL_PROP_KEYS: Partial<Record<AnalyticsEventName, readonly string[]>> = {
  paywall_viewed: ['entry_point', 'offerings_loaded'],
  // NEX-234: the launch-gate paywall fires before onboarding (pre-consent), so
  // dismissals are only captured via the consent-grant backfill. No done-flag
  // version bump needed — no historical build logged this event, and new
  // installs replay it before setting the flag.
  paywall_dismissed: ['entry_point'],
  paywall_reoffer_shown: ['trigger', 'reoffer_number', 'entry_point'],
  paywall_reoffer_started: ['trigger', 'reoffer_number', 'entry_point'],
  subscription_started: ['period_type', 'plan', 'product_id'],
  subscription_restored: ['period_type', 'plan', 'product_id'],
  // NEX-301: same pre-consent-instant reasoning as subscription_started —
  // see the v5→v6 comment above.
  trial_nudge_scheduled: ['day', 'identifier'],
  trial_nudge_tapped: ['day', 'identifier'],
  onboarding_phase_started: ['phase'],
  // NEX-299: was previously stripped of everything (see the v4→v5 comment
  // above) — full prop coverage across every real call site: inspire
  // progression (`total`), pulse resolution (`source`/`reason`), ring-tint
  // (`tint`), and the two new timing props on first-win's emission.
  onboarding_step_completed: [
    'phase', 'step', 'key', 'total', 'source', 'reason', 'tint',
    'seconds_since_onboarding_start', 'backgrounded_during_onboarding',
  ],
  // NEX-299: extended with the two new timing props (optional attachment).
  onboarding_finished: [
    'mandates', 'habits', 'todos', 'ringTint',
    'seconds_since_onboarding_start', 'backgrounded_during_onboarding',
  ],
  first_mandate_committed: ['mandate_count', 'categories', 'source'],
  first_alignment_score_seen: ['score_band', 'hours_since_activation'],
  habit_completed: ['habit_id', 'source', 'is_first'],
  // NEX-222: low-frequency, replay-worthy. Uses the NEX-188 contract array so
  // the allow-list can't drift from the spec. `app_opened` is deliberately NOT
  // here — it fires every foreground, so consent-grant replay would flood
  // PostHog; it is live-forward only (still consent-gated by trackEvent).
  item_captured: ITEM_CAPTURED_KEYS,
  // NEX-215: SURFACED reach signal (confirmation_jump / home_echo). Low-frequency,
  // replay-worthy. Uses the NEX-188 contract array so the allow-list can't drift.
  // The `_v4` flag bump forces a one-time replay of pre-consent reach rows.
  captured_item_first_reached: CAPTURED_ITEM_FIRST_REACHED_KEYS,
};

const ALLOWED_MANDATE_CATEGORIES = new Set(['business', 'vision', 'personal']);

function sanitizeReplayProps(ev: AnalyticsEvent): Record<string, string | number | boolean | null> {
  const allowed = BACKFILL_PROP_KEYS[ev.name];
  if (!allowed) return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of allowed) {
    if (!(key in ev.props)) continue;
    let value = ev.props[key];
    // Re-normalize the category whitelist on replay too (defense in depth).
    if (ev.name === 'first_mandate_committed' && key === 'categories' && typeof value === 'string') {
      value = value
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .map((c) => (ALLOWED_MANDATE_CATEGORIES.has(c) ? c : 'other'))
        .join(',');
    }
    out[key] = value;
  }
  return out;
}

// Deterministic 32-hex → UUID-shaped string from a seed (FNV-1a, 4 salted passes).
function deterministicUuid(seed: string): string {
  const hashHex = (salt: number): string => {
    let h = 0x811c9dc5 ^ salt;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  const hex = hashHex(0) + hashHex(0x9e3779b1) + hashHex(0x85ebca77) + hashHex(0xc2b2ae3d);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

let backfillInFlight = false;

export async function backfillFunnelEventsToPostHog(): Promise<void> {
  if (backfillInFlight) return;
  const client = posthogClient;
  if (!client) return; // no client yet — a later consent/provider tick retries
  // Claim the mutex synchronously, BEFORE any await. The consent effect re-runs
  // on [posthog, analyticsConsent]; without claiming before the getItem await,
  // two near-simultaneous calls would both pass the guard and double-replay.
  backfillInFlight = true;
  try {
    try {
      const done = await AsyncStorage.getItem(KEY_POSTHOG_BACKFILL_DONE);
      if (done === '1') return;
    } catch {}
    const events = await loadEvents();
    const replay = events
      .filter((e) => e.name in BACKFILL_PROP_KEYS && !e.sent)
      .slice()
      .sort((a, b) => a.ts - b.ts);
    for (const ev of replay) {
      try {
        const replayProps = sanitizeReplayProps(ev);
        client.capture(ev.name, replayProps, {
          timestamp: new Date(ev.ts),
          // Seed from the SAME sanitized props the live path used (capture_id is
          // allow-listed for item_captured), so live↔backfill UUIDs still match.
          uuid: deterministicUuid(eventUuidSeed(ev.name, ev.ts, replayProps)),
        });
        ev.sent = true;
      } catch {}
    }
    // Mark done only AFTER the queue is flushed, so a crash mid-replay re-runs
    // (idempotent via deterministic UUID) instead of silently losing events.
    try {
      await client.flush?.();
    } catch {}
    try {
      await AsyncStorage.setItem(KEY_POSTHOG_BACKFILL_DONE, '1');
    } catch {}
    void persistEvents();
  } finally {
    backfillInFlight = false;
  }
}

// ─── Real install time ────────────────────────────────────────────────────────
//
// PostHog's own "Application Installed" only fires once capture is enabled, i.e. after
// the user opts in, which can be days after the real install (it landed 2 days after
// onboarding in the 2026-10-11 audit trace). Record the first launch locally, then send
// one `app_install_recorded` at that original timestamp when capture is enabled, so
// install-first funnels have a true start.
const KEY_FIRST_LAUNCH = 'nexus_first_launch_at_v1';
const KEY_INSTALL_SENT = 'nexus_install_recorded_sent_v1';

export async function ensureFirstLaunchRecorded(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_FIRST_LAUNCH);
    const existing = raw ? Number(raw) : NaN;
    if (Number.isFinite(existing) && existing > 0) return existing;
    // Existing installs: the oldest locally logged event is the best lower bound.
    const events = await loadEvents();
    const oldest = events.length ? Math.min(...events.map((e) => e.ts)) : Date.now();
    const ts = Math.min(Date.now(), oldest);
    await AsyncStorage.setItem(KEY_FIRST_LAUNCH, String(ts));
    return ts;
  } catch {
    return null;
  }
}

export async function sendInstallRecordedToPostHog(): Promise<void> {
  const client = posthogClient;
  if (!client || !clientIsCapturing(client)) return;
  try {
    if ((await AsyncStorage.getItem(KEY_INSTALL_SENT)) === '1') return;
    const ts = await ensureFirstLaunchRecorded();
    if (!ts) return;
    client.capture(
      'app_install_recorded',
      {},
      { timestamp: new Date(ts), uuid: deterministicUuid(`app_install_recorded|${ts}`) },
    );
    await AsyncStorage.setItem(KEY_INSTALL_SENT, '1');
  } catch {}
}

export async function getEvents(): Promise<AnalyticsEvent[]> {
  return loadEvents();
}

export async function getEventsByName(name: AnalyticsEventName): Promise<AnalyticsEvent[]> {
  const events = await loadEvents();
  return events.filter((e) => e.name === name);
}

// ─── Activation lifecycle ─────────────────────────────────────────────────────

export async function getActivationFiredAt(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_ACTIVATION_FIRED);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function markActivationFired(ts: number): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_ACTIVATION_FIRED, String(ts));
  } catch {}
}

// ─── Baseline activation rate (first 50 users) ────────────────────────────────
//
// This is on-device only. Each install is one user from this device's
// perspective. The aggregate across installs requires a server sink —
// out of scope for NEX-17. What this returns is the data we'd ship to
// that sink: the cohort index for this install (was this install one of
// the first 50?) and whether activation fired.

interface BaselineCohortRecord {
  cohortIndex: number;     // 1-based; set on first install
  activatedDate: string | null;
  activationFiredAt: number | null;
}

export async function ensureBaselineCohortRecord(
  activatedDate: string | null,
): Promise<BaselineCohortRecord> {
  try {
    const raw = await AsyncStorage.getItem(KEY_BASELINE_COHORT);
    if (raw) {
      const parsed = JSON.parse(raw) as BaselineCohortRecord;
      // Refresh fields that can change post-creation. cohortIndex is set-once.
      const next: BaselineCohortRecord = {
        ...parsed,
        activatedDate: activatedDate ?? parsed.activatedDate,
        activationFiredAt: parsed.activationFiredAt,
      };
      await AsyncStorage.setItem(KEY_BASELINE_COHORT, JSON.stringify(next));
      return next;
    }
  } catch {}
  const fresh: BaselineCohortRecord = {
    cohortIndex: 1, // Local-only — server-side would assign a real cohort index.
    activatedDate,
    activationFiredAt: null,
  };
  try {
    await AsyncStorage.setItem(KEY_BASELINE_COHORT, JSON.stringify(fresh));
  } catch {}
  return fresh;
}

export async function recordBaselineActivation(ts: number): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY_BASELINE_COHORT);
    if (!raw) return;
    const parsed = JSON.parse(raw) as BaselineCohortRecord;
    if (parsed.activationFiredAt) return; // already recorded
    parsed.activationFiredAt = ts;
    await AsyncStorage.setItem(KEY_BASELINE_COHORT, JSON.stringify(parsed));
  } catch {}
}

export { BASELINE_COHORT_SIZE };

// ─── Server-side events (NEX-67) ──────────────────────────────────────────────
//
// emit{HabitLogged,TodoCleared} write to the Supabase nexus_events table
// for the server-derived activation funnel. Additive — the local
// trackEvent / activation tracker above is independent and unchanged.
//
// Day-key is computed in the user's local timezone so "3 consecutive days"
// reads as "3 of MY days." Fire-and-forget; analytics must not block UX.

function getLocalDayKeyForNexusEvents(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function emitNexusEvent(
  eventName: 'habit_logged' | 'todo_cleared',
  source?: string,
): Promise<void> {
  if (replaySuppressed) return; // dev onboarding replay — mute Supabase inserts too
  try {
    const { data } = await supabase.auth.getUser();
    const userId = data?.user?.id;
    if (!userId) return;
    const { error } = await supabase.from('nexus_events').insert({
      user_id:    userId,
      event_name: eventName,
      day_key:    getLocalDayKeyForNexusEvents(),
      source:     source ?? null,
    });
    if (error) console.warn(`[analytics] ${eventName} insert failed:`, error.message);
  } catch (e: any) {
    console.warn(`[analytics] ${eventName} unexpected error:`, e?.message ?? e);
  }
}

/**
 * NEX-215 (L-4): emit the SURFACED `captured_item_first_reached` reach signal.
 * Call from an unambiguously-attributable surfaced affordance only
 * (`confirmation_jump`, `home_echo`) — NOT a hunt path (would falsely read as
 * surfaced). Consent-gated + PII-free (all props are opaque ids / enums).
 *
 * `age_bucket` is included only when the capture time is reliably known; when it
 * is missing / `0` sentinel / non-finite the prop is omitted and the reach is
 * still recorded (the attribution is the valuable part). Dedup to one row per
 * capture is handled by the `name|capture_id` UUID seed in `eventUuidSeed`.
 */
export async function emitCapturedItemFirstReached(args: {
  captureId: string;
  surface: CaptureSurface;
  accessMethod: AccessMethod;
  capturedAtMs?: number | null;
  reachedAtMs?: number;
}): Promise<void> {
  const reachedAtMs = args.reachedAtMs ?? Date.now();
  const props: Record<string, string> = {
    capture_id: args.captureId,
    item_type: itemTypeForSurface(args.surface),
    surface: args.surface,
    access_method: args.accessMethod,
  };
  if (
    typeof args.capturedAtMs === 'number' &&
    Number.isFinite(args.capturedAtMs) &&
    args.capturedAtMs > 0
  ) {
    props.age_bucket = ageBucket(args.capturedAtMs, reachedAtMs);
  }
  await trackEvent('captured_item_first_reached', props);
}

export function emitHabitLogged(source?: string): void {
  void emitNexusEvent('habit_logged', source);
}

export function emitTodoCleared(source?: string): void {
  void emitNexusEvent('todo_cleared', source);
}
