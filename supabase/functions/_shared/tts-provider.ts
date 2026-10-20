/**
 * Pure decisions behind the /tts provider switch (ElevenLabs first, OpenAI
 * fallback). Plan: docs/plans/2026-09-03-eye-command-center.md, PR 1.
 *
 * Nothing here touches the network, the clock, or Deno globals: the handler
 * in ai-proxy/index.ts feeds in the env reader, the elapsed time and the
 * upstream status, and this module answers "which provider, with what
 * deadline, and is the breaker open". That split is what lets the whole
 * failure matrix run under `deno test` locally and in CI.
 *
 * Run: deno test --allow-import supabase/functions/_shared/tts-provider.test.ts
 */

export type TtsProvider = 'elevenlabs' | 'openai';

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

export type ElevenLabsConfigState = 'ok' | 'disabled' | 'missing' | 'invalid_voice_id';

export type EnvReader = (name: string) => string | undefined;

/** The one register the coach speaks in; a Supabase secret, never a request knob. */
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5';

/**
 * A render-time fence for the 6s ElevenLabs deadline, not a product limit.
 * Measured 2026-09-04 (flash v2.5, mp3_44100_128, full buffer): about 0.3s
 * to first byte plus 2.2ms per character, so 1,500 characters renders in
 * about 3.1s and 2,500 lands on the deadline itself. A coach reply is a few
 * hundred characters; one past the fence speaks in the OpenAI voice for
 * that turn instead of being truncated. OpenAI keeps its own 4096 cap in
 * the handler.
 */
export const ELEVENLABS_MAX_CHARS = 1500;

/**
 * One end-to-end budget, measured from the moment the proxy RECEIVED the
 * request (before auth and the limiter), not from the handler. The client
 * gives up at 15s (coach-tts.ts) and its clock started before the network,
 * so the proxy must answer inside 13s of receipt or the client falls back
 * to the system voice while the proxy is still burning wall time.
 */
export const TTS_TOTAL_BUDGET_MS = 13_000;
/** ElevenLabs gets at most this much; the rest of the budget stays for the fallback. */
export const ELEVENLABS_DEADLINE_MS = 6_000;
/** Below this there is no point starting an upstream call. */
export const TTS_MIN_USEFUL_MS = 1_500;
/** Mirrors the client's own "clip too small to be audio" check. */
export const TTS_MIN_AUDIO_BYTES = 64;

/** Response header naming the provider that produced the bytes (smoke + debugging; no PII). */
export const TTS_PROVIDER_HEADER = 'X-Tts-Provider';

// The voice id is interpolated into the upstream URL; keep it to what
// ElevenLabs ids look like so a bad secret cannot become a path.
const VOICE_ID_RE = /^[A-Za-z0-9]{8,64}$/;
const MODEL_ID_RE = /^[a-z0-9_.-]{3,64}$/;

export function readElevenLabsConfig(env: EnvReader): { config: ElevenLabsConfig | null; state: ElevenLabsConfigState } {
  const disabled = (env('ELEVENLABS_DISABLED') ?? '').trim().toLowerCase();
  if (disabled === '1' || disabled === 'true') return { config: null, state: 'disabled' };
  const apiKey = (env('ELEVENLABS_API_KEY') ?? '').trim();
  const voiceId = (env('ELEVENLABS_VOICE_ID') ?? '').trim();
  if (!apiKey || !voiceId) return { config: null, state: 'missing' };
  if (!VOICE_ID_RE.test(voiceId)) return { config: null, state: 'invalid_voice_id' };
  const rawModel = (env('ELEVENLABS_MODEL_ID') ?? '').trim();
  // A typo in the optional model id must not silence the product voice.
  const modelId = rawModel && MODEL_ID_RE.test(rawModel) ? rawModel : ELEVENLABS_DEFAULT_MODEL;
  return { config: { apiKey, voiceId, modelId }, state: 'ok' };
}

export type TtsDecisionReason =
  | 'ok'
  | 'disabled'
  | 'missing'
  | 'invalid_voice_id'
  | 'breaker_open'
  | 'budget'
  | 'too_long';

export function decideTtsProvider(input: {
  configState: ElevenLabsConfigState;
  breakerOpen: boolean;
  textLength: number;
  /** Time already spent on this request before the decision (auth, limiter). */
  elapsedMs: number;
  openAiAvailable?: boolean;
}): { provider: TtsProvider; reason: TtsDecisionReason } {
  if (input.configState !== 'ok') return { provider: 'openai', reason: input.configState };
  if (input.breakerOpen) return { provider: 'openai', reason: 'breaker_open' };
  // A deadline too short to be worth an attempt must not be tried: the
  // timeout it would produce says nothing about ElevenLabs, and three of
  // them would open the breaker for a failure that never happened.
  if (!worthAttempting(elevenLabsDeadlineMs(input.elapsedMs, input.openAiAvailable))) return { provider: 'openai', reason: 'budget' };
  // The fence holds even when there is no OpenAI path: a text past it would
  // time out at 6s (measured) and then fail anyway, having spent the budget
  // and counted against the breaker for a failure that was ours.
  if (input.textLength > ELEVENLABS_MAX_CHARS) return { provider: 'openai', reason: 'too_long' };
  return { provider: 'elevenlabs', reason: 'ok' };
}

// ─── Failure classification + circuit breaker ────────────────────────────────

/**
 * What an ElevenLabs failure was, for metrics. The breaker only cares
 * whether it is HARD (the account or config is wrong; the next request will
 * fail the same way) or SOFT (a burst, a blip, a slow body: try again).
 *   auth      401/403: bad or suspended key.
 *   quota     402, or a body naming quota or credits (ElevenLabs sends
 *             `quota_exceeded` with a 401): the plan is spent until it resets.
 *   rejected  a body naming voice_not_found / model_not_found: the secret
 *             points at something that is gone.
 *   rate      429: on Creator that is the 5-concurrent-request cap, a
 *             sub-second burst artifact, never an outage on its own.
 *   request   other 400/404/422: per-request validation, possibly text-specific.
 *   upstream  5xx.
 *   timeout   our deadline fired.
 *   bad_body  200 that is not audio, or too small to be a clip.
 *   network   fetch threw for a non-timeout reason.
 */
export type ElevenLabsFailureKind =
  | 'auth'
  | 'quota'
  | 'rejected'
  | 'rate'
  | 'request'
  | 'upstream'
  | 'timeout'
  | 'bad_body'
  | 'network';

export function classifyElevenLabsFailure(status: number, bodySnippet: string): ElevenLabsFailureKind {
  const body = (bodySnippet ?? '').toLowerCase();
  // `max_character_limit_exceeded` is a per-request validation error, not
  // the plan's quota: it must classify as `request`, so no `character_limit`
  // alternation here.
  if (status === 402 || /quota_exceeded|\bquota\b|\bcredits?\b/.test(body)) return 'quota';
  if (/voice_not_found|model_not_found/.test(body)) return 'rejected';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status === 400 || status === 404 || status === 422) return 'request';
  return 'upstream';
}

export type BreakerSeverity = 'hard' | 'soft';

export function severityOf(kind: ElevenLabsFailureKind): BreakerSeverity {
  return kind === 'auth' || kind === 'quota' || kind === 'rejected' ? 'hard' : 'soft';
}

const HARD_OPEN_MS = 10 * 60_000;
const SOFT_OPEN_MS = 60_000;
/** Soft failures open the breaker only after this many in a row. */
export const SOFT_TRIP_THRESHOLD = 3;

/**
 * How long a failure of this kind should stop us trying ElevenLabs, given
 * how many failures in a row preceded it (this one included). 0 = stay
 * closed: a single soft blip costs one fallback, not a minute of them.
 */
export function breakerOpenDurationMs(kind: ElevenLabsFailureKind, consecutiveFailures: number): number {
  if (severityOf(kind) === 'hard') return HARD_OPEN_MS;
  return consecutiveFailures >= SOFT_TRIP_THRESHOLD ? SOFT_OPEN_MS : 0;
}

export interface BreakerSnapshot {
  openUntil: number;
  consecutiveFailures: number;
  lastKind: ElevenLabsFailureKind | null;
}

export interface FailureRecord {
  /** This failure opened a closed breaker. */
  newlyOpened: boolean;
  openForMs: number;
  /**
   * This kind has not been reported at an opening since the last success. Together
   * with `newlyOpened` this is the "report to Sentry" signal: one event per
   * outage per kind, not one per request and not one per re-open (a
   * quota-exhausted month re-opens every ten minutes for weeks).
   */
  firstOfKind: boolean;
}

export interface Breaker {
  isOpen(now: number): boolean;
  recordSuccess(): void;
  recordFailure(kind: ElevenLabsFailureKind, now: number): FailureRecord;
  snapshot(): BreakerSnapshot;
}

/**
 * Per-isolate state. Supabase runs many isolates and recycles them, so this
 * is a latency guard (stop paying a 6s timeout on every request during an
 * outage), not a global spend control. The spend bound is the ElevenLabs plan
 * cap itself, which trips `quota` here and flips the voice to OpenAI.
 */
export function createBreaker(): Breaker {
  let openUntil = 0;
  let consecutiveFailures = 0;
  let lastKind: ElevenLabsFailureKind | null = null;
  const reportedKinds = new Set<ElevenLabsFailureKind>();
  return {
    isOpen(now) {
      if (openUntil === 0) return false;
      if (now < openUntil) return true;
      // The window elapsed: close and forget the streak so one new blip
      // does not immediately reopen it.
      openUntil = 0;
      consecutiveFailures = 0;
      return false;
    },
    recordSuccess() {
      openUntil = 0;
      consecutiveFailures = 0;
      lastKind = null;
      reportedKinds.clear();
    },
    recordFailure(kind, now) {
      consecutiveFailures += 1;
      lastKind = kind;
      const firstOfKind = !reportedKinds.has(kind);
      const wasOpen = openUntil !== 0 && now < openUntil;
      const openForMs = breakerOpenDurationMs(kind, consecutiveFailures);
      // A failure that lands while the breaker is already open (a request
      // that was in flight when it tripped) reports but does not move the
      // window: stragglers must not turn one outage into a rolling one.
      if (openForMs > 0 && !wasOpen) {
        openUntil = now + openForMs;
        reportedKinds.add(kind);
      }
      return { newlyOpened: openForMs > 0 && !wasOpen, openForMs, firstOfKind };
    },
    snapshot() {
      return { openUntil, consecutiveFailures, lastKind };
    },
  };
}

// ─── Budget ──────────────────────────────────────────────────────────────────

/** Deadline for the ElevenLabs attempt, given time already spent on this request. */
export function elevenLabsDeadlineMs(elapsedMs: number, openAiAvailable = true): number {
  // Leave a usable fallback plus 500ms for dispatch overhead. No reserve
  // is needed on a project where OpenAI is not configured.
  const reserve = openAiAvailable ? TTS_MIN_USEFUL_MS + 500 : 0;
  return Math.max(0, Math.min(ELEVENLABS_DEADLINE_MS, TTS_TOTAL_BUDGET_MS - elapsedMs - reserve));
}

/** Deadline for the OpenAI call (fallback or primary), given time already spent. */
export function openAiDeadlineMs(elapsedMs: number): number {
  return Math.max(0, TTS_TOTAL_BUDGET_MS - elapsedMs);
}

export function worthAttempting(deadlineMs: number): boolean {
  return deadlineMs >= TTS_MIN_USEFUL_MS;
}

// ─── Wire shape ──────────────────────────────────────────────────────────────

export const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';

export function buildElevenLabsRequest(
  config: ElevenLabsConfig,
  text: string,
): { url: string; init: { method: 'POST'; headers: Record<string, string>; body: string } } {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: config.modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
      }),
    },
  };
}

/** A 200 is only a clip if it says it is audio and is big enough to be one. */
export function validateAudioResponse(contentType: string | null, byteLength: number): boolean {
  const ct = (contentType ?? '').toLowerCase();
  if (!ct.startsWith('audio/')) return false;
  return byteLength >= TTS_MIN_AUDIO_BYTES;
}
