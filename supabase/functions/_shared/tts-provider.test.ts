/**
 * The /tts provider switch, decision by decision: config reading, provider
 * choice, the failure matrix, breaker timing under a fake clock, the budget
 * math, the wire shape, and what counts as audio.
 *
 * Run: deno test --allow-import supabase/functions/_shared/tts-provider.test.ts
 */

import { assert, assertEquals, assertFalse } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  breakerOpenDurationMs,
  buildElevenLabsRequest,
  classifyElevenLabsFailure,
  createBreaker,
  decideTtsProvider,
  ELEVENLABS_DEADLINE_MS,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_MAX_CHARS,
  elevenLabsDeadlineMs,
  openAiDeadlineMs,
  readElevenLabsConfig,
  severityOf,
  SOFT_TRIP_THRESHOLD,
  TTS_TOTAL_BUDGET_MS,
  validateAudioResponse,
  worthAttempting,
} from './tts-provider.ts';

const envOf = (vars: Record<string, string | undefined>) => (name: string) => vars[name];
const GOOD = { ELEVENLABS_API_KEY: 'sk_test', ELEVENLABS_VOICE_ID: 'DZ2ULBbuhpX6zJYCQic4' };

// ─── config ──────────────────────────────────────────────────────────────────

Deno.test('config: key + voice id → ok with the default model', () => {
  const { config, state } = readElevenLabsConfig(envOf(GOOD));
  assertEquals(state, 'ok');
  assertEquals(config?.modelId, ELEVENLABS_DEFAULT_MODEL);
  assertEquals(config?.voiceId, 'DZ2ULBbuhpX6zJYCQic4');
});

Deno.test('config: kill switch wins over a complete config', () => {
  for (const flag of ['1', 'true', ' TRUE ']) {
    assertEquals(readElevenLabsConfig(envOf({ ...GOOD, ELEVENLABS_DISABLED: flag })).state, 'disabled');
  }
  assertEquals(readElevenLabsConfig(envOf({ ...GOOD, ELEVENLABS_DISABLED: '0' })).state, 'ok');
});

Deno.test('config: missing key or voice id → missing', () => {
  assertEquals(readElevenLabsConfig(envOf({ ELEVENLABS_VOICE_ID: 'DZ2ULBbuhpX6zJYCQic4' })).state, 'missing');
  assertEquals(readElevenLabsConfig(envOf({ ELEVENLABS_API_KEY: 'sk' })).state, 'missing');
  assertEquals(readElevenLabsConfig(envOf({ ELEVENLABS_API_KEY: '  ', ELEVENLABS_VOICE_ID: 'x' })).state, 'missing');
});

Deno.test('config: a voice id that could become a path is refused', () => {
  for (const bad of ['../voices', 'abc', 'DZ2ULBbuhpX6zJYCQic4/stream', 'id with space', 'a'.repeat(65)]) {
    assertEquals(readElevenLabsConfig(envOf({ ...GOOD, ELEVENLABS_VOICE_ID: bad })).state, 'invalid_voice_id', bad);
  }
});

Deno.test('config: a valid model id is kept, a typo falls back to the default', () => {
  assertEquals(readElevenLabsConfig(envOf({ ...GOOD, ELEVENLABS_MODEL_ID: 'eleven_turbo_v2_5' })).config?.modelId, 'eleven_turbo_v2_5');
  assertEquals(readElevenLabsConfig(envOf({ ...GOOD, ELEVENLABS_MODEL_ID: 'Eleven Flash!' })).config?.modelId, ELEVENLABS_DEFAULT_MODEL);
});

// ─── decision ────────────────────────────────────────────────────────────────

const decide = (over: Partial<Parameters<typeof decideTtsProvider>[0]>) =>
  decideTtsProvider({ configState: 'ok', breakerOpen: false, textLength: 10, elapsedMs: 0, ...over });

Deno.test('decide: every non-ok config state routes to OpenAI with its own reason', () => {
  for (const state of ['disabled', 'missing', 'invalid_voice_id'] as const) {
    assertEquals(decide({ configState: state }), { provider: 'openai', reason: state });
  }
});

Deno.test('decide: open breaker and overlong text route to OpenAI; otherwise ElevenLabs', () => {
  assertEquals(decide({ breakerOpen: true }).reason, 'breaker_open');
  assertEquals(decide({ textLength: ELEVENLABS_MAX_CHARS + 1 }).reason, 'too_long');
  assertEquals(decide({ textLength: ELEVENLABS_MAX_CHARS }), { provider: 'elevenlabs', reason: 'ok' });
});

Deno.test('decide: a budget too short for a real attempt skips ElevenLabs without touching the breaker', () => {
  // 11.6s already spent: 1.4s left, under the 1.5s floor.
  assertEquals(decide({ elapsedMs: 11_600 }), { provider: 'openai', reason: 'budget' });
  // The fallback reserve moves the ElevenLabs cutoff to 9.5s.
  assertEquals(decide({ elapsedMs: 9_500 }).provider, 'elevenlabs');
  assertEquals(decide({ elapsedMs: 9_501 }).reason, 'budget');
  assertEquals(decide({ elapsedMs: 11_500, openAiAvailable: false }).provider, 'elevenlabs');
  assertEquals(decide({ elapsedMs: 13_000 }).reason, 'budget');
});

Deno.test('fence: 1,500 characters, from the measured 2.2ms per character against the 6s deadline', () => {
  assertEquals(ELEVENLABS_MAX_CHARS, 1500);
  assert(ELEVENLABS_MAX_CHARS * 2.2 + 300 < ELEVENLABS_DEADLINE_MS / 1.5, 'fence must render inside two thirds of the deadline');
});

// ─── failure matrix ──────────────────────────────────────────────────────────

Deno.test('classify: ElevenLabs quota arrives as a 401 with quota_exceeded, and as a 402', () => {
  assertEquals(classifyElevenLabsFailure(401, '{"detail":{"status":"quota_exceeded","message":"..."}}'), 'quota');
  assertEquals(classifyElevenLabsFailure(402, ''), 'quota');
  assertEquals(classifyElevenLabsFailure(429, 'You have 3 credits remaining'), 'quota');
});

Deno.test('classify: a per-request character cap is a request error, not the plan quota', () => {
  assertEquals(classifyElevenLabsFailure(400, '{"detail":{"status":"max_character_limit_exceeded"}}'), 'request');
});

Deno.test('classify: a 401 that says "credentials" is auth, not quota', () => {
  assertEquals(classifyElevenLabsFailure(401, '{"detail":{"status":"invalid_api_key","message":"check your credentials"}}'), 'auth');
  assertEquals(classifyElevenLabsFailure(401, 'You have 12 credits left'), 'quota');
});

Deno.test('classify: auth, rejected, rate, request, upstream', () => {
  assertEquals(classifyElevenLabsFailure(401, '{"detail":{"status":"detected_unusual_activity"}}'), 'auth');
  assertEquals(classifyElevenLabsFailure(403, ''), 'auth');
  assertEquals(classifyElevenLabsFailure(404, '{"detail":{"status":"voice_not_found"}}'), 'rejected');
  assertEquals(classifyElevenLabsFailure(400, '{"detail":{"status":"model_not_found"}}'), 'rejected');
  assertEquals(classifyElevenLabsFailure(429, '{"detail":{"status":"too_many_concurrent_requests"}}'), 'rate');
  assertEquals(classifyElevenLabsFailure(422, '{"detail":[{"msg":"text too long"}]}'), 'request');
  assertEquals(classifyElevenLabsFailure(400, ''), 'request');
  assertEquals(classifyElevenLabsFailure(500, ''), 'upstream');
  assertEquals(classifyElevenLabsFailure(503, ''), 'upstream');
});

Deno.test('severity: only auth, quota and a missing voice/model are hard', () => {
  for (const kind of ['auth', 'quota', 'rejected'] as const) assertEquals(severityOf(kind), 'hard', kind);
  for (const kind of ['rate', 'request', 'upstream', 'timeout', 'bad_body', 'network'] as const) assertEquals(severityOf(kind), 'soft', kind);
});

Deno.test('breaker durations: hard opens ten minutes on the first hit; soft needs a streak, 429 included', () => {
  assertEquals(breakerOpenDurationMs('auth', 1), 600_000);
  assertEquals(breakerOpenDurationMs('quota', 1), 600_000);
  assertEquals(breakerOpenDurationMs('rejected', 1), 600_000);
  for (const kind of ['rate', 'request', 'upstream', 'timeout', 'bad_body', 'network'] as const) {
    assertEquals(breakerOpenDurationMs(kind, SOFT_TRIP_THRESHOLD - 1), 0, kind);
    assertEquals(breakerOpenDurationMs(kind, SOFT_TRIP_THRESHOLD), 60_000, kind);
  }
});

// ─── breaker under a fake clock ──────────────────────────────────────────────

Deno.test('breaker: quota opens at once, reports newlyOpened once, and closes after the window', () => {
  const b = createBreaker();
  assertFalse(b.isOpen(1_000));
  const first = b.recordFailure('quota', 1_000);
  assertEquals(first, { newlyOpened: true, openForMs: 600_000, firstOfKind: true });
  assert(b.isOpen(1_001));
  // A second failure inside the window is not a new outage.
  assertEquals(b.recordFailure('quota', 2_000).newlyOpened, false);
  assert(b.isOpen(600_999));
  assertFalse(b.isOpen(601_000));
  assertEquals(b.snapshot().consecutiveFailures, 0);
});

Deno.test('breaker: a re-open after the window is newlyOpened but not firstOfKind (one Sentry event per outage)', () => {
  const b = createBreaker();
  b.recordFailure('quota', 0);
  assertFalse(b.isOpen(600_000)); // window elapsed, probe allowed
  const again = b.recordFailure('quota', 600_000);
  assertEquals(again.newlyOpened, true);
  assertEquals(again.firstOfKind, false);
  // A different kind during the same outage is still reported once.
  assertEquals(b.recordFailure('auth', 600_001).firstOfKind, true);
});

Deno.test('breaker: two soft blips stay closed, the third opens for a minute', () => {
  const b = createBreaker();
  assertEquals(b.recordFailure('timeout', 0).newlyOpened, false);
  assertFalse(b.isOpen(1));
  assertEquals(b.recordFailure('upstream', 10).newlyOpened, false);
  assertFalse(b.isOpen(11));
  const third = b.recordFailure('bad_body', 20);
  assertEquals(third, { newlyOpened: true, openForMs: 60_000, firstOfKind: true });
  assert(b.isOpen(60_019));
  assertFalse(b.isOpen(60_020));
});

Deno.test('breaker: a lone 429 (concurrency burst) does not trip', () => {
  const b = createBreaker();
  assertEquals(b.recordFailure('rate', 0), { newlyOpened: false, openForMs: 0, firstOfKind: true });
  assertFalse(b.isOpen(1));
});

Deno.test('breaker: a success resets the streak, closes an open breaker, and re-arms firstOfKind', () => {
  const b = createBreaker();
  b.recordFailure('timeout', 0);
  b.recordFailure('timeout', 1);
  b.recordSuccess();
  assertEquals(b.recordFailure('timeout', 2).newlyOpened, false);
  assertFalse(b.isOpen(3));
  b.recordFailure('auth', 10);
  assert(b.isOpen(11));
  b.recordSuccess();
  assertFalse(b.isOpen(12));
  assertEquals(b.recordFailure('auth', 13).firstOfKind, true);
});

Deno.test('breaker: a failure that lands while already open does not move the window', () => {
  const b = createBreaker();
  b.recordFailure('auth', 0); // open until 600_000
  b.recordFailure('rate', 100); // an in-flight straggler
  assert(b.isOpen(599_999));
  assertFalse(b.isOpen(600_000));
});

// ─── budget ──────────────────────────────────────────────────────────────────

Deno.test('budget: ElevenLabs gets at most 6s of the 13s, and the fallback gets what is left', () => {
  assertEquals(TTS_TOTAL_BUDGET_MS, 13_000);
  assertEquals(elevenLabsDeadlineMs(0), ELEVENLABS_DEADLINE_MS);
  assertEquals(openAiDeadlineMs(0), TTS_TOTAL_BUDGET_MS);
  // 500ms of auth + limiter, then ElevenLabs used its whole deadline: the
  // fallback still has 6.5s.
  assertEquals(elevenLabsDeadlineMs(500), 6_000);
  assertEquals(openAiDeadlineMs(6_500), 6_500);
  // Late in the budget the ElevenLabs deadline shrinks to the remainder.
  assertEquals(elevenLabsDeadlineMs(10_000), 1_000);
  assertEquals(elevenLabsDeadlineMs(10_000, false), 3_000);
  assertEquals(elevenLabsDeadlineMs(14_000), 0);
  assertEquals(openAiDeadlineMs(14_000), 0);
});

Deno.test('budget: sub-1.5s deadlines are not worth an upstream call', () => {
  assertFalse(worthAttempting(0));
  assertFalse(worthAttempting(1_499));
  assert(worthAttempting(1_500));
});

// ─── wire shape ──────────────────────────────────────────────────────────────

Deno.test('request: stream endpoint, mp3 44.1k, api key header, no OpenAI-only fields', () => {
  const { url, init } = buildElevenLabsRequest({ apiKey: 'sk_x', voiceId: 'DZ2ULBbuhpX6zJYCQic4', modelId: 'eleven_flash_v2_5' }, 'Today, return.');
  assertEquals(url, 'https://api.elevenlabs.io/v1/text-to-speech/DZ2ULBbuhpX6zJYCQic4/stream?output_format=mp3_44100_128');
  assertEquals(init.method, 'POST');
  assertEquals(init.headers['xi-api-key'], 'sk_x');
  assertEquals(init.headers['Accept'], 'audio/mpeg');
  const body = JSON.parse(init.body);
  assertEquals(body.text, 'Today, return.');
  assertEquals(body.model_id, 'eleven_flash_v2_5');
  assertEquals(body.voice_settings, { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true });
  assertEquals('instructions' in body, false);
  assertEquals('voice' in body, false);
});

// ─── what counts as audio ────────────────────────────────────────────────────

Deno.test('audio: a JSON 200, a bare 200, or a tiny clip is not audio', () => {
  assertFalse(validateAudioResponse('application/json', 5_000));
  assertFalse(validateAudioResponse(null, 5_000));
  assertFalse(validateAudioResponse('audio/mpeg', 63));
  assert(validateAudioResponse('audio/mpeg', 64));
  assert(validateAudioResponse('Audio/MPEG; charset=binary', 4_000));
});

Deno.test('breaker: homogeneous soft outages alert on opening, dedup reopens, and reset on success', () => {
  for (const kind of ['upstream', 'timeout'] as const) {
    const b = createBreaker();
    const events = [0, 1, 2].map((t) => b.recordFailure(kind, t));
    assertEquals(events.filter((r) => r.newlyOpened && r.firstOfKind).length, 1);
    assertEquals(events[2].firstOfKind, true);
    assertFalse(b.isOpen(60_002));
    const reopened = [60_002, 60_003, 60_004].map((t) => b.recordFailure(kind, t));
    assertEquals(reopened.filter((r) => r.newlyOpened && r.firstOfKind).length, 0);
    b.recordSuccess();
    b.recordFailure(kind, 70_000);
    b.recordFailure(kind, 70_001);
    assertEquals(b.recordFailure(kind, 70_002).firstOfKind, true);
  }
});

Deno.test('budget: every attempted late ElevenLabs call preserves a usable fallback', () => {
  for (const elapsedMs of [5_500, 5_501, 7_000, 9_000, 9_500, 9_501, 11_500]) {
    const decision = decide({ elapsedMs });
    if (decision.provider === 'elevenlabs') {
      const afterTimeout = elapsedMs + elevenLabsDeadlineMs(elapsedMs) + 100;
      assert(worthAttempting(openAiDeadlineMs(afterTimeout)), String(elapsedMs));
    } else {
      assertEquals(decision.reason, 'budget');
    }
  }
});
