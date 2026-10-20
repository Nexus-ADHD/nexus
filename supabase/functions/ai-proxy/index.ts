/**
 * Nexus AI Proxy — Supabase Edge Function
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Replaces the Genspark Claw cloudflared tunnel (NEX-62). Hardened from
 * day 1 per NEX-63: two-layer auth (Supabase JWT + X-App-Token),
 * per-user and per-IP rate limits, OpenAI/Anthropic keys held as
 * Supabase secrets and never exposed to the client.
 *
 * Routes (matching the legacy proxy's wire shape so the iOS client
 * needs only a URL flip + Authorization header to cut over):
 *
 *   POST /functions/v1/ai-proxy/chat
 *     Body:    { model, messages, response_format?, max_completion_tokens? }
 *   POST /tts  { text, voice? } → audio/mpeg (the coach's spoken reply: ElevenLabs
 *              when configured, OpenAI gpt-4o-mini-tts otherwise or on any failure)
 *     Returns: an OpenAI Chat Completions response. Verbatim for OpenAI
 *              and Kimi models (api.moonshot.ai is Chat Completions
 *              compatible); translated from Anthropic's Messages shape for
 *              `claude-*` models (NEX-311). The client speaks exactly one
 *              dialect either way — a provider swap must never become a
 *              client migration.
 *
 *   POST /functions/v1/ai-proxy/transcribe
 *     Body:    multipart/form-data with `file` (audio.m4a) + `model`
 *     Returns: { text } from OpenAI Whisper verbatim
 *
 * Required headers (BOTH layers must pass):
 *   Authorization: Bearer <supabase-user-jwt>   ← who is this user
 *   X-App-Token:   <static-secret>              ← is this the Nexus app
 *
 * Required secrets (set via `supabase secrets set <NAME>=<VALUE>`):
 *   OPENAI_API_KEY        — OpenAI API key
 *   AI_PROXY_APP_TOKEN    — Static token bundled in the iOS production
 *                            build (rotated per the NEX-63 runbook in docs/)
 *   AI_PROXY_APP_TOKEN_PREVIEW
 *                          — Static token bundled in TestFlight preview
 *                            builds. Accepted alongside AI_PROXY_APP_TOKEN
 *                            so preview access can be revoked independently
 *                            of production (NEX-97 follow-up).
 *   (ANTHROPIC_API_KEY)   — Required ONLY for `claude-*` models. The /chat
 *                            route picks its provider from the requested
 *                            model (NEX-311): `claude-*` goes to Anthropic's
 *                            Messages API and is translated back into Chat
 *                            Completions before it reaches the client;
 *                            `kimi-*` goes to Moonshot's OpenAI-compatible
 *                            endpoint verbatim (kimi-shape.ts); everything
 *                            else goes to OpenAI unchanged.
 *                            Absent this key, a claude-* request 500s with a
 *                            named error rather than being silently posted to
 *                            OpenAI, which is what the pre-NEX-305 routing
 *                            table would have done.
 *   (MOONSHOT_API_KEY)    — Required ONLY for `kimi-*` models (same named-
 *                            error 500 when absent). Moonshot has no
 *                            transcription API, so /transcribe stays on
 *                            OpenAI Whisper regardless of the chat routing.
 *
 * Supabase provides automatically (no setup):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Database dependency: the `ai_rate_limits` table + `increment_rate_limit`
 * function, created in supabase/migrations/20260401000000_baseline_core_tables.sql.
 *
 * Failure modes:
 *   401 — missing or invalid X-App-Token, or missing/invalid user JWT
 *   404 — unknown route (only /chat and /transcribe are recognized)
 *   429 — per-user or per-IP rate limit exceeded
 *   502 — OpenAI returned an error; the body is forwarded for debugging
 *   Rate-limiter failure: fails OPEN. The proxy is defense-in-depth, not
 *   a hard security gate. OpenAI's own quota is the backstop.
 */

import { boundChatRequest } from '../_shared/chat-limits.ts';
import { runTtsRequest, readTtsErrorBody } from '../_shared/tts-request.ts';
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { initLogger } from 'https://esm.sh/braintrust@3.17.0';
import { captureEdgeError } from '../_shared/sentry.ts';
import {
  ANTHROPIC_ENDPOINT,
  ANTHROPIC_VERSION,
  isAnthropicModel,
  toAnthropicRequest,
  toChatCompletions,
  toChatCompletionsError,
} from '../_shared/anthropic-shape.ts';
import { MOONSHOT_ENDPOINT, isKimiModel, toKimiRequest } from '../_shared/kimi-shape.ts';
import {
  buildElevenLabsRequest,
  classifyElevenLabsFailure,
  createBreaker,
  decideTtsProvider,
  ELEVENLABS_DEADLINE_MS,
  type ElevenLabsConfig,
  type ElevenLabsFailureKind,
  elevenLabsDeadlineMs,
  openAiDeadlineMs,
  readElevenLabsConfig,
  TTS_PROVIDER_HEADER,
  type TtsProvider,
  validateAudioResponse,
  worthAttempting,
} from '../_shared/tts-provider.ts';

// Edge functions don't bundle generated DB types, so the service-role client is
// untyped. `ReturnType<typeof createClient>` resolves to the DEFAULT generic (a
// `never`-schema client) which (a) doesn't match the client inferred at the call
// site and (b) makes `rpc('increment_rate_limit', ...)` reject its args as
// `undefined`. Use one permissive client type for every helper signature so they
// match the inferred client and the rpc accepts its args. See NEX-170.
type EdgeClient = SupabaseClient<any, any, any>;

// ─── Config ────────────────────────────────────────────────────────────────

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
// NEX-311: required only when a claude-* model is requested (see anthropic-shape.ts).
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
// Required only when a kimi-* model is requested (see kimi-shape.ts).
const MOONSHOT_API_KEY = Deno.env.get('MOONSHOT_API_KEY');
// Accept either the production token or the preview token. Tokens are
// stored as separate secrets so preview access can be revoked or rotated
// independently of production (NEX-97 follow-up after Greptile review).
const APP_TOKENS: ReadonlySet<string> = new Set(
  [
    Deno.env.get('AI_PROXY_APP_TOKEN'),
    Deno.env.get('AI_PROXY_APP_TOKEN_PREVIEW'),
  ].filter((t): t is string => typeof t === 'string' && t.length > 0),
);
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

// ─── Braintrust (METRICS-ONLY) ───────────────────────────────────────────────
//
// PRIVACY: this proxy carries real user content (mandates, habits,
// reflections). We deliberately DO NOT use wrapOpenAI, because that captures
// full prompt + completion text into Braintrust. Logging is metrics-only: a
// manual span records ONLY model, surface, token counts, and latency (Braintrust
// derives cost from model + token metrics). No messages, context, or completion
// text ever leaves the proxy into logs. Best-effort and fully decoupled from the
// response: a Braintrust outage, throw, or slow flush can never alter, delay, or
// throw into the verbatim OpenAI passthrough below. See NEX-89.
const BRAINTRUST_API_KEY = Deno.env.get('BRAINTRUST_API_KEY');
// Guard module load: an initLogger throw on cold start must NOT 500 the whole
// function (every route shares this module). Degrade to btLogger = null (no
// logging) instead of crashing module evaluation.
let btLogger: ReturnType<typeof initLogger> | null = null;
try {
  if (BRAINTRUST_API_KEY) btLogger = initLogger({ projectName: 'nexus-ai-proxy', apiKey: BRAINTRUST_API_KEY });
} catch (e) {
  console.error('[ai-proxy] initLogger failed (ignored):', e instanceof Error ? e.message : e);
}

// Rate limits per route per minute. Tuned for premium-app usage where a
// real session might fire 3-5 chat calls in a burst (onboarding) and a
// few transcribes (Pulse voice). Doubled for IP because households
// share IPs.
const RATE_LIMITS = {
  // 2026-10-20: Nexus is free. Daily ceilings sit ~10x above the heaviest
  // real user (13 chat calls/day over the last 3 days) so normal use never
  // hits them and one account cannot run up the AI bill.
  chat:       { perUser: 30, perIp: 60, windowSec: 60, perUserDay: 150 },
  transcribe: { perUser: 15, perIp: 30, windowSec: 60, perUserDay: 60 },
  // One spoken reply per coach turn; the coach's own limit is /chat's. The
  // daily window is per user only (a per-IP daily key would lock a carrier
  // NAT out for a day); with TTS_MAX_CHARS it bounds the OpenAI fallback's
  // spend per account. The ElevenLabs bound is the plan's own monthly cap
  // with usage-based overage OFF, which trips the breaker and flips the voice
  // to OpenAI; ELEVENLABS_DISABLED=1 is the manual stop.
  tts:        { perUser: 30, perIp: 60, windowSec: 60, perUserDay: 150 },
} as const;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-app-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ─── Response helpers ──────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function jsonError(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

// NEX-282: deadline on every upstream OpenAI call (request + body read). A
// stalled upstream otherwise holds the client connection open — a trickling
// body defeats the client's idle timeout — and burns isolate wall time.
// Split budgets: /chat carries long-output completions (deep reviews, mandate
// generation) that can legitimately run tens of seconds non-streamed;
// /transcribe is a single short Whisper round-trip.
const CHAT_UPSTREAM_TIMEOUT_MS = 60_000;
const TRANSCRIBE_UPSTREAM_TIMEOUT_MS = 30_000;
// /tts budgets live in _shared/tts-provider.ts: one 13s end-to-end budget
// measured from request receipt (inside the client's 15s), ElevenLabs
// capped at 6s of it.
// OpenAI's hard input cap for the speech endpoint.
const TTS_MAX_CHARS = 4096;
const TTS_MODEL = 'gpt-4o-mini-tts';
// The one register the coach speaks in. Steered by `instructions` (a
// gpt-4o-mini-tts feature), never by the caller: the voice is product, not
// a per-request knob.
const TTS_VOICES = new Set(['ash', 'sage', 'coral', 'alloy', 'echo', 'onyx', 'shimmer', 'nova', 'fable', 'ballad', 'verse']);
const TTS_DEFAULT_VOICE = 'ash';
const TTS_INSTRUCTIONS =
  'A mentor who has been paying attention. Unhurried, low, warm but never bright. Plain statements that land with weight. No upspeak, no sales energy, no exclamation.';

// AbortSignal.timeout rejects with a DOMException named 'TimeoutError';
// accept 'AbortError' too for runtime variance across Deno versions.
function isUpstreamTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

// ─── Metrics spans (Braintrust, best-effort) ───────────────────────────────
//
// Everything here is wrapped so a Braintrust outage, a throw, or a slow flush
// can NEVER alter, delay, or throw into a response. Flush is handed to
// EdgeRuntime.waitUntil when available (the isolate can freeze after
// returning, silently dropping an ended-but-unflushed span); otherwise it
// stays a detached, caught promise, never awaited. `close` is idempotent so a
// handler can call it on every exit path without bookkeeping.

interface MetricsSpan {
  active: boolean;
  close(fields: Record<string, unknown>): void;
}

function startMetricsSpan(name: string, type: 'llm' | 'task'): MetricsSpan {
  let span: ReturnType<NonNullable<typeof btLogger>['startSpan']> | null = null;
  if (btLogger) {
    try {
      span = btLogger.startSpan({ name, spanAttributes: { type } });
    } catch (e) {
      console.error('[ai-proxy] Braintrust startSpan failed (ignored):', e instanceof Error ? e.message : e);
      span = null;
    }
  }
  return {
    active: span !== null,
    close(fields) {
      if (!span) return;
      const s = span;
      span = null;
      try {
        s.log(fields);
        s.end();
        const flushing = Promise.resolve()
          .then(() => btLogger!.flush())
          .catch((flushErr) =>
            console.error('[ai-proxy] Braintrust flush failed (ignored):', flushErr instanceof Error ? flushErr.message : flushErr),
          );
        // @ts-ignore EdgeRuntime is a Supabase Deno runtime global.
        if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
          // @ts-ignore
          EdgeRuntime.waitUntil(flushing);
        }
      } catch (e) {
        console.error('[ai-proxy] Braintrust logging failed (ignored):', e instanceof Error ? e.message : e);
      }
    },
  };
}

// ─── Auth ──────────────────────────────────────────────────────────────────

interface AuthedUser {
  id: string;
  email?: string;
}

/**
 * Two-layer auth. Both layers are now HARD gates:
 *   1. X-App-Token — static secret bundled in the iOS client. Confirms
 *      the request is coming from the Nexus app.
 *   2. Supabase user JWT — a real signed-in session. Confirms there
 *      is an authenticated user.
 *
 * Previously the JWT layer was soft because the proxy was called during
 * onboarding before the user signed in with Apple. NEX-64 was supposed to
 * fix that by signing in anonymously at app launch, making every cold start
 * authenticated.
 *
 * THAT NEVER WORKED, and the justification above used to say it did.
 * Anonymous sign-ins are disabled on the Supabase project, so the client's
 * signInAnonymously() call failed silently on every launch — verified
 * 2026-08-28: zero auth.identities rows with provider 'anonymous', ever,
 * across 177 users since April. The dead call was removed then.
 *
 * Requiring the JWT is still safe, but for a DIFFERENT reason: while signed
 * out the app renders only AuthScreen, so nothing reaches this proxy before a
 * real sign-in. That is a property of the client's routing, not of a
 * guaranteed session.
 *
 * So: do not move an AI call before sign-in and assume this will authorise it.
 * It will 401. Enable anonymous sign-ins on the project first if you need
 * pre-signin AI.
 *
 * Returns the user on success, or a Response to short-circuit on failure.
 */
async function authenticate(
  req: Request,
  supabase: EdgeClient,
): Promise<AuthedUser | Response> {
  // Layer 1: app token (static, bundled in IPA). Accepts either the
  // production or preview token so the two environments can be revoked
  // independently. APP_TOKENS is empty in a misconfigured deploy, which
  // fails closed (every request gets a 401).
  const appToken = req.headers.get('x-app-token');
  if (APP_TOKENS.size === 0 || !appToken || !APP_TOKENS.has(appToken)) {
    return jsonError(401, 'Invalid app token');
  }

  // Layer 2: user JWT. Required.
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonError(401, 'Missing user authorization');
  }
  const jwt = authHeader.slice(7);
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user) {
    return jsonError(401, 'Invalid user authorization');
  }
  return { id: data.user.id, email: data.user.email };
}

// ─── Rate limiting ─────────────────────────────────────────────────────────

/**
 * Calls the `increment_rate_limit` Postgres function, which atomically
 * increments a counter keyed on the rate-limit identity. Returns the
 * post-increment count.
 *
 * Fails OPEN on Postgres errors — the rate limiter is defense-in-depth,
 * not a hard security gate. The OpenAI/Anthropic quota itself is the
 * backstop against runaway costs.
 */
async function incrementRateLimit(
  supabase: EdgeClient,
  key: string,
  windowSec: number,
): Promise<number> {
  const { data, error } = await supabase.rpc('increment_rate_limit', {
    p_key: key,
    p_window_sec: windowSec,
  });
  if (error) {
    console.error('[ai-proxy] rate-limit RPC failed, failing open:', error);
    return 0; // fail open
  }
  return typeof data === 'number' ? data : 0;
}

async function checkRateLimits(
  supabase: EdgeClient,
  userId: string,
  ip: string,
  route: keyof typeof RATE_LIMITS,
): Promise<Response | null> {
  const limits = RATE_LIMITS[route];

  const userKey = `user:${userId}:${route}`;
  const userCount = await incrementRateLimit(supabase, userKey, limits.windowSec);
  if (userCount > limits.perUser) {
    return jsonError(429, `Per-user rate limit exceeded (${limits.perUser}/${limits.windowSec}s)`);
  }

  // 2026-10-18: a per-user daily ceiling on top of the per-minute one, so a
  // single account cannot run the minute limit around the clock.
  const perUserDay = (limits as { perUserDay?: number }).perUserDay;
  if (perUserDay) {
    const dayCount = await incrementRateLimit(supabase, `user:${userId}:${route}:day`, 86400);
    if (dayCount > perUserDay) {
      return jsonError(429, `Daily limit reached (${perUserDay}/day)`);
    }
  }

  const ipKey = `ip:${ip}:${route}`;
  const ipCount = await incrementRateLimit(supabase, ipKey, limits.windowSec);
  if (ipCount > limits.perIp) {
    return jsonError(429, `Per-IP rate limit exceeded (${limits.perIp}/${limits.windowSec}s)`);
  }

  return null; // OK
}

function clientIp(req: Request): string {
  // 2026-10-18: the FIRST x-forwarded-for entry is whatever the caller wrote,
  // so keying on it let one client rotate fake IPs past the per-IP limit.
  // Prefer the edge-set cf-connecting-ip, else the LAST hop (added by our
  // own load balancer, not the client).
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return 'unknown';
}

// ─── Route: /chat ──────────────────────────────────────────────────────────

async function handleChat(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON body');
  }

  // ── Metrics-only span (added; never affects the response) ──────────────────
  // `surface` is an optional non-content tag the client MAY send for grouping;
  // `model` is read for span metadata only. Neither is content. Open the span
  // BEFORE the call so its start/end bracket true upstream latency. Span
  // creation is best-effort — a throw here is swallowed and we proceed with no
  // logging.
  const surface =
    body && typeof body === 'object' && typeof (body as Record<string, unknown>).surface === 'string'
      ? (body as Record<string, string>).surface
      : undefined;
  const model =
    body && typeof body === 'object' && typeof (body as Record<string, unknown>).model === 'string'
      ? (body as Record<string, string>).model
      : undefined;

  // NEX-311: provider is chosen by the requested model, nothing else. The key
  // check is now provider-aware and happens AFTER the body is read, because
  // before this route existed there was only one provider and only one key to
  // check. A missing OPENAI_API_KEY must not 500 a Claude request, and vice
  // versa — that coupling is exactly what made the old "flip enableClaude"
  // footgun invisible.
  const useAnthropic = isAnthropicModel(model);
  const useKimi = !useAnthropic && isKimiModel(model);

  // 2026-10-18: bound the cost levers (n, output cap, premium models) before
  // anything is forwarded. Content is untouched.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'Invalid JSON body');
  }
  const bounded = boundChatRequest(body as Record<string, unknown>, useAnthropic);
  if (!bounded.ok) return jsonError(400, bounded.error);
  body = bounded.body;
  const provider = useAnthropic ? 'anthropic' : useKimi ? 'kimi' : 'openai';
  const providerKey = useAnthropic ? ANTHROPIC_API_KEY : useKimi ? MOONSHOT_API_KEY : OPENAI_API_KEY;
  if (!providerKey) {
    const keyName = useAnthropic ? 'ANTHROPIC_API_KEY' : useKimi ? 'MOONSHOT_API_KEY' : 'OPENAI_API_KEY';
    captureEdgeError(new Error(`ai-proxy: ${keyName} not configured`), {
      fn: 'ai-proxy',
      criticalPath: false,
      extra: { reason: 'provider_key_missing', route: 'chat', provider },
    });
    return jsonError(500, `${keyName} not configured`);
  }
  const metrics = startMetricsSpan('chat', 'llm');
  const spanMetadata = {
    ...(model ? { model } : {}),
    ...(surface ? { surface } : {}),
    // NEX-311: which provider actually served the call. Without this the
    // Braintrust spans cannot answer "is the Claude tier live?" — the exact
    // question the old decorative routing table could not answer either.
    provider,
  };

  // NEX-282: bounded upstream call. The signal covers the response-body read
  // too — a trickling body would otherwise hang `text()` past any client
  // deadline while burning isolate wall time. Timeout maps to 504, which the
  // iOS client's fetchWithRetry treats as retryable.
  let openaiResp: Response;
  let text: string;
  try {
    if (useAnthropic) {
      // NEX-311: Anthropic speaks a different dialect in BOTH directions, so
      // the request is translated on the way out and the response is
      // translated back on the way in. The iOS client only ever sees Chat
      // Completions — a provider swap must never become a client migration.
      const upstream = await fetch(ANTHROPIC_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': providerKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(toAnthropicRequest(body)),
        signal: AbortSignal.timeout(CHAT_UPSTREAM_TIMEOUT_MS),
      });
      const raw = await upstream.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      // Translate errors too. Left raw, an upstream 4xx reaches the client as
      // an unrecognized blob and surfaces as "no usable text" instead of the
      // actual reason — the same class of invisibility that let a nonexistent
      // provider route sit in the codebase for months.
      text = JSON.stringify(
        upstream.ok
          ? toChatCompletions(parsed, String(model ?? ''))
          : toChatCompletionsError(parsed, upstream.status),
      );
      openaiResp = new Response(null, { status: upstream.status });
    } else if (useKimi) {
      // Kimi speaks Chat Completions natively, so the body passes through
      // verbatim except the legacy max_tokens rename (see kimi-shape.ts),
      // and the response is forwarded untouched exactly like OpenAI's below.
      openaiResp = await fetch(MOONSHOT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${providerKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(toKimiRequest(body)),
        signal: AbortSignal.timeout(CHAT_UPSTREAM_TIMEOUT_MS),
      });
      text = await openaiResp.text();
    } else {
      openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${providerKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CHAT_UPSTREAM_TIMEOUT_MS),
      });

      // Forward OpenAI's response verbatim — the iOS client expects the
      // standard Chat Completions shape.
      text = await openaiResp.text();
    }
  } catch (e) {
    if (isUpstreamTimeout(e)) {
      metrics.close({ metadata: { ...spanMetadata, timeout: true } });
      captureEdgeError(new Error(`ai-proxy: upstream ${provider} timeout (chat)`), {
        fn: 'ai-proxy',
        criticalPath: false,
        extra: {
          reason: 'upstream_timeout',
          route: 'chat',
          provider,
          timeoutMs: CHAT_UPSTREAM_TIMEOUT_MS,
        },
      });
      return jsonError(504, 'Upstream AI request timed out');
    }
    // Non-timeout throw (plain network error): close the span so Braintrust
    // error rates stay honest, then propagate exactly as before.
    metrics.close({ metadata: { ...spanMetadata, error: true } });
    throw e;
  }

  // NEX-327: a non-OK upstream response is forwarded verbatim below, but
  // until now it was invisible to Sentry — only timeouts and missing keys
  // were captured, so Moonshot 404ing the retired kimi-k2.5 on EVERY chat
  // call raised no error signal at all. Metrics-style tags only (status,
  // provider, route) — never the upstream body, per the privacy stance at
  // the top of this file. The Anthropic branch's translated-error path builds
  // openaiResp as `new Response(null, { status })`, so it is captured here
  // identically.
  if (!openaiResp.ok) {
    captureEdgeError(new Error(`ai-proxy: upstream ${provider} returned ${openaiResp.status} (chat)`), {
      fn: 'ai-proxy',
      criticalPath: false,
      extra: { reason: 'upstream_error', route: 'chat', provider, status: openaiResp.status },
    });
  }

  // ── Best-effort metrics-only logging (added) ───────────────────────────────
  // Everything here is wrapped so a Braintrust outage, a JSON parse error, a
  // throw, or a slow flush can NEVER alter, delay, or throw into the verbatim
  // response returned below. We read ONLY token counts from the already-fetched
  // body and log model + surface + tokens + latency. No messages, no context,
  // no completion text. On an upstream error body (no `usage`), we still end the
  // span with metadata and skip metrics. Logging failure = swallow + console.error.
  if (metrics.active) {
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    try {
      usage = JSON.parse(text)?.usage;
    } catch {
      usage = undefined; // non-JSON or upstream error body
    }
    metrics.close({
      metadata: spanMetadata,
      ...(usage
        ? {
            metrics: {
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
              total_tokens: usage.total_tokens,
            },
          }
        : {}),
    });
  }

  return new Response(text, {
    status: openaiResp.status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': openaiResp.headers.get('content-type') ?? 'application/json',
    },
  });
}

// ─── Route: /transcribe ────────────────────────────────────────────────────

// ─── Handler: /tts ─────────────────────────────────────────────────────────
//
// Body: { text: string, voice?: string }. Returns audio/mpeg bytes (the whole
// clip; the client buffers to a file and plays it). The coach's spoken reply
// (docs/plans/2026-09-03-coach-v2-real-chat.md PR 1; the provider switch is
// PR 1 of the Eye plan, docs/plans/2026-09-03-eye-command-center.md, which
// lands with #493). The text is the model's
// own reply, never the person's words, and both providers receive it
// (docs/privacy/data-collection.md).
//
// Provider order: ElevenLabs when its secrets are set, the kill switch is off,
// the breaker is closed and the text is inside its fence; otherwise, or on
// any ElevenLabs failure, OpenAI with whatever is left of the one end-to-end
// budget. Every decision lives in _shared/tts-provider.ts and is tested
// there; this handler only does I/O. The clip is buffered rather than
// streamed through because a fallback is impossible once a 200 has started
// streaming.

// Per isolate: a latency guard during an ElevenLabs outage, not a global
// spend control (see createBreaker).
const elevenLabsBreaker = createBreaker();

type ElevenLabsOutcome =
  | { ok: true; bytes: ArrayBuffer }
  | { ok: false; kind: ElevenLabsFailureKind; status: number | null };

async function synthesizeElevenLabs(
  config: ElevenLabsConfig,
  text: string,
  deadlineMs: number,
  requestSignal: AbortSignal,
): Promise<ElevenLabsOutcome> {
  const { url, init } = buildElevenLabsRequest(config, text);
  // One signal covers the request AND the body read: reading after the
  // deadline rejects, so a trickling body cannot outlive the budget.
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(deadlineMs)]);
  let upstream: Response;
  try {
    upstream = await fetch(url, { ...init, signal });
  } catch (e) {
    return { ok: false, kind: isUpstreamTimeout(e) ? 'timeout' : 'network', status: null };
  }
  if (!upstream.ok) {
    const snippet = await upstream.text().then((t) => t.slice(0, 200)).catch(() => '');
    return { ok: false, kind: classifyElevenLabsFailure(upstream.status, snippet), status: upstream.status };
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await upstream.arrayBuffer();
  } catch (e) {
    return { ok: false, kind: isUpstreamTimeout(e) ? 'timeout' : 'bad_body', status: upstream.status };
  }
  if (!validateAudioResponse(upstream.headers.get('content-type'), bytes.byteLength)) {
    return { ok: false, kind: 'bad_body', status: upstream.status };
  }
  return { ok: true, bytes };
}

function audioResponse(bytes: ArrayBuffer, provider: TtsProvider): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      [TTS_PROVIDER_HEADER]: provider,
    },
  });
}

async function handleTts(req: Request, startedAt: number, requestSignal: AbortSignal): Promise<Response> {
  // Read per request so a `secrets set` (kill switch, voice change) takes
  // effect on the next call, not the next cold start.
  const el = readElevenLabsConfig((name) => Deno.env.get(name));
  if (!OPENAI_API_KEY && !el.config) {
    captureEdgeError(new Error('ai-proxy: no speech provider configured'), {
      fn: 'ai-proxy',
      criticalPath: false,
      extra: { reason: 'tts_provider_missing', route: 'tts', elevenlabs: el.state },
    });
    return jsonError(500, 'No speech provider configured');
  }
  let body: { text?: unknown; voice?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON body');
  }
  requestSignal.throwIfAborted();
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return jsonError(400, 'text is required');
  if (text.length > TTS_MAX_CHARS) return jsonError(413, `text exceeds ${TTS_MAX_CHARS} characters`);
  // An OpenAI-only knob. ElevenLabs has exactly one voice: the secret.
  const voice = typeof body.voice === 'string' && TTS_VOICES.has(body.voice) ? body.voice : TTS_DEFAULT_VOICE;

  const decision = decideTtsProvider({
    configState: el.state,
    breakerOpen: elevenLabsBreaker.isOpen(Date.now()),
    textLength: text.length,
    elapsedMs: Date.now() - startedAt,
    openAiAvailable: Boolean(OPENAI_API_KEY),
  });
  // Metrics only: provider attempted vs served, the reason, sizes, latency.
  // Never the text.
  const metrics = startMetricsSpan('tts', 'task');
  const meta: Record<string, unknown> = {
    provider_attempted: decision.provider,
    decision_reason: decision.reason,
    chars: text.length,
  };
  const finish = (fields: Record<string, unknown>): void =>
    metrics.close({ metadata: { ...meta, ...fields, total_ms: Date.now() - startedAt } });

  const deadline = elevenLabsDeadlineMs(Date.now() - startedAt, Boolean(OPENAI_API_KEY));
  if (decision.provider === 'elevenlabs' && el.config && worthAttempting(deadline)) {
    const t0 = Date.now();
    const outcome = await synthesizeElevenLabs(el.config, text, deadline, requestSignal);
    meta.elevenlabs_ms = Date.now() - t0;
    if (outcome.ok) {
      elevenLabsBreaker.recordSuccess();
      finish({ provider_served: 'elevenlabs', status: 200 });
      return audioResponse(outcome.bytes, 'elevenlabs');
    }
    meta.fallback_reason = outcome.kind;
    meta.elevenlabs_status = outcome.status;
    console.error(
      `[ai-proxy] elevenlabs ${outcome.kind} (status ${outcome.status ?? 'none'}); falling back to openai`,
    );
    // A timeout on a deadline the budget had already cut short says nothing
    // about ElevenLabs; it must not count toward opening the breaker.
    const truncatedDeadline = outcome.kind === 'timeout' && deadline < ELEVENLABS_DEADLINE_MS;
    const trip = truncatedDeadline
      ? { newlyOpened: false, openForMs: 0, firstOfKind: false }
      : elevenLabsBreaker.recordFailure(outcome.kind, Date.now());
    // One Sentry event per outage per kind: not one per request, and not
    // one per ten-minute re-open during a quota-exhausted month. Single soft
    // blips stay in Braintrust only.
    if (trip.newlyOpened && trip.firstOfKind) {
      captureEdgeError(new Error(`ai-proxy: elevenlabs ${outcome.kind}, breaker open (tts)`), {
        fn: 'ai-proxy',
        criticalPath: false,
        extra: {
          reason: 'elevenlabs_breaker_open',
          route: 'tts',
          kind: outcome.kind,
          status: outcome.status,
          openForMs: trip.openForMs,
        },
      });
    }
  }

  // ── OpenAI: the fallback, or the primary when ElevenLabs is not in play ──
  if (!OPENAI_API_KEY) {
    // ElevenLabs was skipped (decision.reason) or tried and failed
    // (meta.fallback_reason); nothing else can speak.
    const why = (meta.fallback_reason as string | undefined) ?? decision.reason;
    finish({ provider_served: null, status: 502 });
    return jsonError(502, `Speech failed: no fallback provider (${why})`);
  }
  const openAiDeadline = openAiDeadlineMs(Date.now() - startedAt);
  if (!worthAttempting(openAiDeadline)) {
    finish({ provider_served: null, status: 504, budget_exhausted: true });
    return jsonError(504, 'Speech budget exhausted');
  }
  const openAiSignal = AbortSignal.any([requestSignal, AbortSignal.timeout(openAiDeadline)]);
  let upstream: Response;
  try {
    upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: text,
        voice,
        instructions: TTS_INSTRUCTIONS,
        response_format: 'mp3',
        speed: 1.0,
      }),
      signal: openAiSignal,
    });
  } catch (e) {
    if (isUpstreamTimeout(e)) {
      captureEdgeError(new Error('ai-proxy: upstream OpenAI timeout (tts)'), {
        fn: 'ai-proxy',
        criticalPath: false,
        extra: { reason: 'upstream_timeout', route: 'tts', timeoutMs: openAiDeadline },
      });
      finish({ provider_served: null, status: 504, timeout: true });
      return jsonError(504, 'Upstream AI request timed out');
    }
    finish({ provider_served: null, status: 502, error: true });
    throw e;
  }
  if (!upstream.ok) {
    const detail = await readTtsErrorBody(upstream);
    captureEdgeError(new Error(`ai-proxy: upstream openai returned ${upstream.status} (tts)`), {
      fn: 'ai-proxy',
      criticalPath: false,
      extra: { reason: 'upstream_error', route: 'tts', status: upstream.status },
    });
    finish({ provider_served: null, status: 502, openai_status: upstream.status });
    return jsonError(502, `Speech failed (${upstream.status}): ${detail}`);
  }
  // Read fully inside the deadline: a trickling body must not hold the
  // client past it (same rule as /chat, NEX-282). The read shares the fetch
  // signal, so a stall here surfaces as the same timeout.
  let bytes: ArrayBuffer;
  try {
    bytes = await upstream.arrayBuffer();
  } catch (e) {
    const timedOut = isUpstreamTimeout(e);
    finish({ provider_served: null, status: timedOut ? 504 : 502, body_read_failed: true });
    return jsonError(timedOut ? 504 : 502, timedOut ? 'Upstream AI request timed out' : 'Speech failed: body read');
  }
  finish({ provider_served: 'openai', status: 200 });
  return audioResponse(bytes, 'openai');
}

async function handleTranscribe(req: Request): Promise<Response> {
  if (!OPENAI_API_KEY) {
    // Pre-call config 500 (no OpenAI call yet — passthrough untouched).
    captureEdgeError(new Error('ai-proxy: OPENAI_API_KEY not configured'), {
      fn: 'ai-proxy',
      criticalPath: false,
      extra: { reason: 'openai_key_missing', route: 'transcribe' },
    });
    return jsonError(500, 'OPENAI_API_KEY not configured');
  }

  // Re-stream the multipart body to OpenAI without re-parsing it. We
  // strip our own auth headers; everything else (Content-Type with
  // boundary, etc.) flows through. NEX-282: bounded like /chat — the signal
  // covers upload, response, and body read; timeout maps to a retryable 504.
  let openaiResp: Response;
  let text: string;
  try {
    openaiResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': req.headers.get('content-type') ?? 'multipart/form-data',
      },
      body: req.body,
      // @ts-ignore — Deno supports `duplex: 'half'` for streaming bodies.
      duplex: 'half',
      signal: AbortSignal.timeout(TRANSCRIBE_UPSTREAM_TIMEOUT_MS),
    });

    text = await openaiResp.text();
  } catch (e) {
    if (isUpstreamTimeout(e)) {
      captureEdgeError(new Error('ai-proxy: upstream OpenAI timeout (transcribe)'), {
        fn: 'ai-proxy',
        criticalPath: false,
        extra: { reason: 'upstream_timeout', route: 'transcribe', timeoutMs: TRANSCRIBE_UPSTREAM_TIMEOUT_MS },
      });
      return jsonError(504, 'Upstream AI request timed out');
    }
    throw e;
  }
  return new Response(text, {
    status: openaiResp.status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': openaiResp.headers.get('content-type') ?? 'application/json',
    },
  });
}

// ─── Main handler ──────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // The /tts budget is measured from here, not from its handler: the
  // client's clock started before the network, and auth + the limiter
  // run before dispatch.
  const receivedAt = Date.now();
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed');
  }

  // Route from the URL path. Supabase routes everything after the
  // function name into req.url, so /functions/v1/ai-proxy/chat lands
  // here with pathname ending in /chat.
  const url = new URL(req.url);
  const segments = url.pathname.split('/').filter(Boolean);
  const route = segments[segments.length - 1];
  if (route !== 'chat' && route !== 'transcribe' && route !== 'tts') {
    return jsonError(404, `Unknown route: ${route}`);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // Config failure, BEFORE any OpenAI call — safe to capture (no passthrough
    // touched). Non-critical: a deploy-misconfig, not a per-user money/auth path.
    captureEdgeError(new Error('ai-proxy: Supabase admin credentials not configured'), {
      fn: 'ai-proxy',
      criticalPath: false,
      extra: { reason: 'supabase_creds_missing' },
    });
    return jsonError(500, 'Supabase admin credentials not configured');
  }

  if (route === 'tts') {
    try {
      return await runTtsRequest(receivedAt, async (signal) => {
        const speechClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            fetch: (input, init) => fetch(input, {
              ...init,
              signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
            }),
          },
        });
        const auth = await authenticate(req, speechClient);
        // Supabase may turn an abort into a normal error result. Never
        // mistake that for invalid credentials or a fail-open limiter.
        signal.throwIfAborted();
        if (auth instanceof Response) return auth;
        const limited = await checkRateLimits(speechClient, auth.id, clientIp(req), 'tts');
        signal.throwIfAborted();
        if (limited) return limited;
        return await handleTts(req, receivedAt, signal);
      }, () => jsonError(504, 'Speech budget exhausted'));
    } catch (err) {
      captureEdgeError(err, { fn: 'ai-proxy', criticalPath: false, extra: { route } });
      return jsonError(502, 'Speech request failed');
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Authenticate (both layers).
  const authResult = await authenticate(req, supabase);
  if (authResult instanceof Response) return authResult;
  const user = authResult;

  // Rate limit.
  const rateLimitResult = await checkRateLimits(supabase, user.id, clientIp(req), route);
  if (rateLimitResult) return rateLimitResult;

  // Dispatch.
  try {
    if (route === 'chat')       return await handleChat(req);
    if (route === 'transcribe') return await handleTranscribe(req);
  } catch (err) {
    console.error(`[ai-proxy] ${route} handler threw:`, err);
    // The upstream call already failed (the verbatim passthrough returns OpenAI's
    // body even on a non-2xx and does NOT throw), so a throw here is a genuine
    // fetch/unexpected failure — safe to capture without touching the passthrough.
    // Non-critical: high-volume route, kept out of the critical_path alert.
    captureEdgeError(err, { fn: 'ai-proxy', criticalPath: false, extra: { route } });
    return jsonError(502, `Upstream call failed: ${(err as Error).message ?? 'unknown'}`);
  }

  return jsonError(404, `Unknown route: ${route}`);
});
