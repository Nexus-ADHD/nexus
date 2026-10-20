/**
 * Nexus AI Client
 * All AI calls are routed through the backend proxy.
 * Direct provider keys (OpenAI, Anthropic) must NEVER be used in the mobile client.
 *
 * If EXPO_PUBLIC_AI_PROXY_URL or EXPO_PUBLIC_AI_PROXY_TOKEN are missing:
 *   - In development: a console.error is emitted and the call throws a clear message.
 *   - In production: the call throws immediately — no silent fallback to direct APIs.
 *
 * Retry behavior: transient network failures and 5xx / 408 / 429 responses
 * are retried with exponential backoff (300ms → 800ms → 1800ms, ±20% jitter,
 * 3 attempts total). Validation errors (other 4xx) fail fast. A 401 caused
 * by a stale user JWT (the first AI call after long backgrounding, before
 * the SDK's lazy refresh lands) gets ONE silent session refresh + retry;
 * a 401 the refresh cannot fix (invalid app token, revoked session) still
 * fails fast.
 *
 * Timeout behavior: chatCompletion and transcribeAudio are both bounded by
 * DEFAULT_AI_TIMEOUT_MS unless the caller passes its own timeoutMs (0 opts
 * out). A deadline miss throws SessionTimeoutError (auth phase) or
 * AiTimeoutError (network phase).
 */

import { MODELS, assertProxyRoutable } from './ai-models';
import { supabase } from '../services/supabase';
import { publicConfigValue } from './public-config';
import { aiSessionGeneration, lastKnownAccessTokenOrNull, rememberAccessToken } from './ai-session-cache';
import {
  MAX_RETRY_ATTEMPTS as MAX_ATTEMPTS,
  RETRYABLE_HTTP_STATUSES as RETRYABLE_STATUSES,
  retryDelayMs as backoff,
  isRetryableNetworkError,
  sleep,
} from './retry-policy';

// Env first, app.json `extra` fallback — Xcode archives never see eas.json
// build-profile env, so the extra mirror is what keeps AI working there.
const PROXY_URL = publicConfigValue(
  'EXPO_PUBLIC_AI_PROXY_URL',
  process.env.EXPO_PUBLIC_AI_PROXY_URL,
);
const PROXY_TOKEN = publicConfigValue(
  'EXPO_PUBLIC_AI_PROXY_TOKEN',
  process.env.EXPO_PUBLIC_AI_PROXY_TOKEN,
);

if (__DEV__) {
  if (!PROXY_URL) {
    console.error(
      '[Nexus] EXPO_PUBLIC_AI_PROXY_URL is not set. ' +
      'AI calls will fail. Copy .env.example to .env.local and fill in the value.',
    );
  }
  if (!PROXY_TOKEN) {
    console.error(
      '[Nexus] EXPO_PUBLIC_AI_PROXY_TOKEN is not set. ' +
      'AI calls will fail. Copy .env.example to .env.local and fill in the value.',
    );
  }
}

// NEX-305: the fallback is MODELS.DEFAULT — a standalone id, NOT an alias of a
// named tier. It used to be MODELS.DAILY_PULSE, which meant re-tiering the
// daily-pulse surface silently re-routed every uncategorized call in the app
// (and made flipping the old enableClaude flag an app-wide outage rather than a
// one-surface change). Prefer naming a tier at the call site over relying on it.
const DEFAULT_MODEL = MODELS.DEFAULT;

// ── Timeout errors (NEX-280) ─────────────────────────────────────────────────
// Typed so callers can map a deadline miss to gentle retry UI instead of the
// generic error alert. A wedged `supabase.auth.getSession()` (lazy token
// refresh after backgrounding) and a stalled proxy fetch are both terminal
// for an interactive capture — the caller needs to know it was a timeout,
// not a parse failure or a config error.

export class AiTimeoutError extends Error {
  constructor(message = 'AI request timed out.') {
    super(message);
    this.name = 'AiTimeoutError';
  }
}

export class SessionTimeoutError extends Error {
  constructor(message = 'Auth session lookup timed out.') {
    super(message);
    this.name = 'SessionTimeoutError';
  }
}

// When a caller sets `timeoutMs`, the auth-session phase is capped at the
// smaller of this and the total budget; the network phase gets the remainder
// (floored at MIN_FETCH_BUDGET_MS so a slow session lookup can't zero it).
const SESSION_LOOKUP_CAP_MS = 6000;
export const MIN_FETCH_BUDGET_MS = 1000;

// ── Last-known token ─────────────────────────────────────────────────────────
// Coach, builds 255/256: every turn failed on the device while the proxy never
// saw a request (edge logs + Braintrust both empty for the window) and two
// other AI calls from the same phone succeeded minutes earlier. The only step
// that fails BEFORE the network is the session lookup: auth-js waits on an
// in-flight refresh with no deadline of its own, the 6s cap fires, and the
// turn dies as SessionTimeoutError. The token from the previous successful
// lookup is still a good bearer for the proxy (it verifies with GoTrue; a
// stale one 401s and the onUnauthorized refresh below covers that), so a
// wedge no longer costs the call: reuse it and record that we did. The cache
// itself lives in ai-session-cache.ts so sign-out can clear it.

export interface AiCallDiagnostics {
  /** The session lookup wedged and the previous token was reused. */
  sessionFallback: boolean;
  /** Wall time of the session lookup phase. */
  sessionMs: number;
}

const DIAGNOSTICS_KEY = 'aiDiagnostics';

function attachDiagnostics<E>(err: E, diagnostics: AiCallDiagnostics): E {
  if (err && typeof err === 'object') {
    try {
      (err as Record<string, unknown>)[DIAGNOSTICS_KEY] = diagnostics;
    } catch {
      // A frozen error object: the report loses the numbers, not the error.
    }
  }
  return err;
}

/**
 * The diagnostics of the call that threw `err`, read off the error itself
 * (never a module global: two calls can be in flight, and the opener and a
 * turn are). Null for an error that did not come through chatCompletion or
 * transcribeAudio.
 */
export function aiDiagnosticsOf(err: unknown): AiCallDiagnostics | null {
  if (!err || typeof err !== 'object') return null;
  const d = (err as Record<string, unknown>)[DIAGNOSTICS_KEY];
  return d && typeof d === 'object' ? (d as AiCallDiagnostics) : null;
}

// Default deadline when the caller omits timeoutMs. NEX-280 scoped the
// deadline to opt-in callers; every surface that never opted in (morning
// brief, weekly reflection, voice journal, pulse, breakdown, horizon review,
// quote generation, goal mapping) could still hang its spinner forever on a
// wedged getSession() or a stalled proxy fetch (PR #314's bug class). Every
// call is now bounded by default; a caller passes its own timeoutMs for a
// tighter interactive deadline, or 0 to explicitly opt out (unbounded).
// 30s is 2-3x the tightest interactive budgets in use (8-15s) — generous
// for the largest single-round generations, small enough that a stuck
// surface recovers into its existing catch/fallback path within one sitting.
export const DEFAULT_AI_TIMEOUT_MS = 30000;

// ── Retry config ─────────────────────────────────────────────────────────────
// Lives in ./retry-policy so the PLAUD MCP client shares one definition rather
// than a second copy that drifts. Imported under the old local names above, so
// the retry loop below is unchanged.

// ── 401 recovery ─────────────────────────────────────────────────────────────
// The proxy 401s a request whose user JWT expired while the app was
// backgrounded (supabase-js refreshes lazily, so the FIRST AI call after a
// long background can race the refresh and lose). fetchWithRetry treated 401
// as fail-fast, so that race surfaced as a user-visible failure on every AI
// surface until the SDK caught up. The recovery below refreshes the session
// once and retries with the new token.

type UnauthorizedRecovery = (response: Response) => Promise<Record<string, string> | null>;

// Single-flight: N parallel calls that 401 together (typical right after
// foregrounding) share one refreshSession() instead of stampeding GoTrue.
// Reset in finally — success and failure both clear it, so a failed refresh
// is never cached and the next 401 gets a fresh attempt.
let refreshInFlight: Promise<string | null> | null = null;
// The generation the in-flight refresh was started under. A refresh account A
// began stays in flight across A's sign-out; account B's 401 recovery must
// start its own instead of joining it and receiving A's token (Greptile
// T-Rex round 3). A caller whose own generation is stale gets null.
let refreshInFlightGeneration = -1;

function refreshAccessToken(capMs: number, generation: number): Promise<string | null> {
  if (generation !== aiSessionGeneration()) return Promise.resolve(null);
  if (!refreshInFlight || refreshInFlightGeneration !== generation) {
    refreshInFlightGeneration = generation;
    const startedIn = generation;
    const run = (async (): Promise<string | null> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          supabase.auth.refreshSession(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new SessionTimeoutError()), capMs);
          }),
        ]);
        const token = result?.data?.session?.access_token ?? null;
        rememberAccessToken(token, startedIn);
        // A sign-out during the refresh: the token is the previous
        // person's and must reach no request.
        return startedIn === aiSessionGeneration() ? token : null;
      } catch {
        // A refresh that fails or wedges is not an error to surface here —
        // the caller falls back to returning the original 401.
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    const shared = run.finally(() => {
      if (refreshInFlight === shared) refreshInFlight = null;
    });
    refreshInFlight = shared;
  }
  return refreshInFlight;
}

// Only a stale/absent USER JWT is fixable by a refresh. 'Invalid app token'
// is a config failure — refreshing would mask it, so it fails fast unchanged.
// Unknown 401 bodies default to attempting the refresh: it is single-shot,
// so a wrong guess costs one extra round-trip, not a loop.
async function isRefreshable401(response: Response): Promise<boolean> {
  try {
    const body = await response.clone().text();
    return !body.includes('app token');
  } catch {
    return true;
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: { onUnauthorized?: UnauthorizedRecovery },
): Promise<Response> {
  let lastErr: unknown;
  let authRetried = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      if (response.status === 401 && opts?.onUnauthorized && !authRetried) {
        // Single-shot per call: one refresh, one retry. A second 401 (or a
        // recovery that returns null) surfaces the original response so the
        // caller's error path fires exactly as it did before this existed.
        authRetried = true;
        const refreshedHeaders = await opts.onUnauthorized(response);
        if (refreshedHeaders) {
          init = { ...init, headers: refreshedHeaders };
          attempt--; // the auth retry does not consume a network attempt
          continue;
        }
        return response;
      }
      if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
        if (__DEV__) {
          console.warn(
            `[Nexus] AI proxy ${response.status}, retrying ` +
            `(attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
          );
        }
        await sleep(backoff(attempt));
        continue;
      }
      return response;
    } catch (err) {
      lastErr = err;
      if (!isRetryableNetworkError(err) || attempt >= MAX_ATTEMPTS - 1) {
        throw err;
      }
      if (__DEV__) {
        console.warn(
          `[Nexus] AI proxy network error, retrying ` +
          `(attempt ${attempt + 1}/${MAX_ATTEMPTS}):`,
          err,
        );
      }
      await sleep(backoff(attempt));
    }
  }
  throw lastErr ?? new Error('AI proxy: retry loop exhausted');
}
// ─────────────────────────────────────────────────────────────────────────────

function requireProxy(): { url: string; token: string } {
  if (!PROXY_URL || !PROXY_TOKEN) {
    throw new Error(
      'AI proxy is not configured. ' +
      'Set EXPO_PUBLIC_AI_PROXY_URL and EXPO_PUBLIC_AI_PROXY_TOKEN in your environment.',
    );
  }
  return { url: PROXY_URL, token: PROXY_TOKEN };
}

async function getHeaders(
  contentType = 'application/json',
  sessionTimeoutMs?: number,
): Promise<{ headers: Record<string, string>; diagnostics: AiCallDiagnostics; generation: number }> {
  const { token } = requireProxy();
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'X-App-Token': token,
  };
  // NEX-63: layered auth. Attach the user's Supabase JWT so the proxy
  // can verify (a) this is the Nexus app via X-App-Token AND (b) the
  // request is from a real signed-in Nexus user. supabase.auth
  // auto-refreshes the token; we silently omit it if there's no
  // session (signed-out flows shouldn't be calling AI anyway).
  const startedAt = Date.now();
  // Captured before the lookup starts: a sign-out while it is in flight must
  // keep its late result out of the cache (see ai-session-cache.ts).
  const startedIn = aiSessionGeneration();
  try {
    const sessionPromise = supabase.auth.getSession();
    let data: Awaited<typeof sessionPromise>['data'] | undefined;
    if (sessionTimeoutMs && sessionTimeoutMs > 0) {
      // NEX-280: a wedged getSession() (lazy token refresh after backgrounding)
      // must fail fast so the caller's retry UI can take over — and must NEVER
      // fall through to a JWT-less request (the proxy 401s those, which
      // surfaces as a scary alert). Promise.race attaches handlers to the
      // session promise, so a late rejection after the timer wins is still
      // handled — no unhandled-rejection noise.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        ({ data } = await Promise.race([
          sessionPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new SessionTimeoutError()), sessionTimeoutMs);
          }),
        ]));
      } finally {
        if (timer) clearTimeout(timer);
      }
    } else {
      ({ data } = await sessionPromise);
    }
    const accessToken = data?.session?.access_token;
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
      rememberAccessToken(accessToken, startedIn);
    }
  } catch (err) {
    if (err instanceof SessionTimeoutError) {
      const sessionMs = Date.now() - startedAt;
      // The cache is read only for a request that began in the CURRENT auth
      // generation: a call account A started before signing out must not go
      // out under a token account B has since cached (Greptile T-Rex round 2).
      const cached = startedIn === aiSessionGeneration() ? lastKnownAccessTokenOrNull() : null;
      // A wedged lookup with nothing usable is still a hard failure: a
      // JWT-less request would only 401 at the proxy. With a cached token the
      // call proceeds (see "Last-known token" above).
      if (!cached) throw attachDiagnostics(err, { sessionFallback: false, sessionMs });
      headers['Authorization'] = `Bearer ${cached}`;
      return { headers, diagnostics: { sessionFallback: true, sessionMs }, generation: startedIn };
    }
    // Session fetch failed; let the proxy 401 us if auth is required.
  }
  return { headers, diagnostics: { sessionFallback: false, sessionMs: Date.now() - startedAt }, generation: startedIn };
}

function getChatUrl(): string {
  const { url } = requireProxy();
  return `${url}/chat`;
}

function getTranscribeUrl(): string {
  const { url } = requireProxy();
  return `${url}/transcribe`;
}

/**
 * The proxy URL for a route and the authenticated headers for one call, for
 * a caller that must use its own fetch (the coach's spoken reply reads bytes
 * through expo/fetch, which this module does not import so it stays
 * Node-testable). Same deadline, token cache and diagnostics as chatCompletion.
 */
export async function aiProxyRequest(
  route: 'tts',
  sessionTimeoutMs: number = SESSION_LOOKUP_CAP_MS,
): Promise<{ url: string; headers: Record<string, string>; diagnostics: AiCallDiagnostics }> {
  const { url } = requireProxy();
  const { headers, diagnostics } = await getHeaders('application/json', sessionTimeoutMs);
  return { url: `${url}/${route}`, headers, diagnostics };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  response_format?:
    | { type: 'json_object' }
    | { type: 'text' }
    // NEX-317: strict Structured Outputs (OpenAI only — the proxy's Anthropic
    // route drops response_format). Forwarded verbatim in the request body.
    | {
        type: 'json_schema';
        json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> };
      };
  // Output token cap. Sent on the wire as `max_completion_tokens` (the only
  // spelling both the gpt-5 family and Kimi accept — see chatCompletion).
  max_tokens?: number;
  // Overall deadline. Bounds BOTH phases of the call: the auth-session lookup
  // (capped at min(SESSION_LOOKUP_CAP_MS, timeoutMs) → SessionTimeoutError)
  // and the network phase including retries + backoff (the remainder of the
  // budget → AiTimeoutError). Worst-case overshoot is roughly one backoff
  // sleep + the MIN_FETCH_BUDGET_MS floor — the backoff sleeps are not
  // abort-aware, so an abort landing mid-sleep is observed when the sleep
  // ends. Omit = DEFAULT_AI_TIMEOUT_MS. Pass 0 to opt out entirely
  // (unbounded — the pre-default legacy behavior; no caller does today).
  timeoutMs?: number;
}

export async function chatCompletion(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const totalBudget = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  const startedAt = Date.now();
  // NEX-280: the deadline covers the session lookup too — the timer used to
  // start only after getHeaders() returned, so a wedged getSession() escaped
  // it entirely and the caller hung with no recourse.
  const { headers, diagnostics, generation } = await getHeaders(
    'application/json',
    totalBudget ? Math.min(SESSION_LOOKUP_CAP_MS, totalBudget) : undefined,
  );
  const fetchBudget = totalBudget
    ? Math.max(MIN_FETCH_BUDGET_MS, totalBudget - (Date.now() - startedAt))
    : undefined;
  const controller = fetchBudget ? new AbortController() : undefined;
  let timedOut = false;
  const timer =
    controller && fetchBudget
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, fetchBudget)
      : undefined;
  // Stale-JWT 401 → one silent refresh + retry. The refresh is capped at the
  // smaller of SESSION_LOOKUP_CAP_MS and the remaining budget; once the
  // budget is spent the recovery declines and the 401 surfaces. If the global
  // deadline fires while the refresh is in flight, the retried fetch aborts
  // immediately and maps to AiTimeoutError via the timedOut flag below.
  const onUnauthorized: UnauthorizedRecovery = async (response) => {
    if (!(await isRefreshable401(response))) return null;
    const remaining = totalBudget ? totalBudget - (Date.now() - startedAt) : Infinity;
    if (remaining <= 0) return null;
    const token = await refreshAccessToken(Math.min(SESSION_LOOKUP_CAP_MS, remaining), generation);
    if (!token) return null;
    return { ...headers, Authorization: `Bearer ${token}` };
  };
  try {
    const response = await fetchWithRetry(getChatUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        // NEX-305/NEX-314: fail loudly here rather than shipping an id the proxy
        // cannot route and surfacing an opaque upstream 400. As of NEX-311 the
        // proxy routes gpt-*/o<N>/chatgpt-* to OpenAI AND claude-* to Anthropic,
        // so the guard is provider-aware (`assertProxyRoutable`), not OpenAI-only
        // — otherwise a claude-* tier would be rejected here before the request
        // ever reached the route that can serve it.
        model: assertProxyRoutable(options.model ?? DEFAULT_MODEL, 'chatCompletion'),
        messages,
        ...(options.response_format ? { response_format: options.response_format } : {}),
        // The wire field is `max_completion_tokens`, never the legacy
        // `max_tokens`: OpenAI's gpt-5 family 400s on the old spelling
        // ("Unsupported parameter: 'max_tokens'"), and a 400 is fail-fast —
        // every caller retry reproduced the identical rejection, which is
        // exactly the Strengthen sheet's RETRY-that-never-changes bug (that
        // surface was the only one passing a token cap). Kimi also documents
        // `max_completion_tokens`, so one spelling serves every route. The
        // option key stays `max_tokens` so call sites don't churn.
        ...(options.max_tokens ? { max_completion_tokens: options.max_tokens } : {}),
      }),
      ...(controller ? { signal: controller.signal } : {}),
    }, { onUnauthorized });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`AI request failed (${response.status}): ${err.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      throw new Error('AI returned no content');
    }
    return content;
  } catch (err) {
    // Convert OUR deadline abort into the typed error; the flag proves the
    // abort came from this call's timer, not some other abort source.
    if (timedOut && err instanceof Error && err.name === 'AbortError') {
      throw attachDiagnostics(new AiTimeoutError(), diagnostics);
    }
    throw attachDiagnostics(err, diagnostics);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const PUNCTUATION_SYSTEM_PROMPT =
  "Return the user's transcribed speech with correct punctuation and " +
  'capitalization. Do not change words, do not add or remove content. ' +
  'Return only the corrected text.';

const punctuationCache = new Map<string, string>();

function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

function alreadyPunctuated(text: string): boolean {
  const last = text.charAt(text.length - 1);
  return last === '.' || last === '?' || last === '!';
}

async function addPunctuation(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (alreadyPunctuated(trimmed)) return raw;

  const key = hashKey(trimmed);
  const cached = punctuationCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const result = await chatCompletion(
      [
        { role: 'system', content: PUNCTUATION_SYSTEM_PROMPT },
        { role: 'user', content: trimmed },
      ],
      // NEX-280: punctuation is cosmetic — never let it hang a transcription.
      // A timeout lands in the catch below and returns the raw text.
      // NEX-325 (Greptile P2): no response_format here — text is the default
      // on every provider the proxy routes, and an explicit { type: 'text' }
      // is only KNOWN to be accepted by OpenAI. A provider that rejects it
      // would turn this call into a silent no-op (the catch returns the raw
      // transcription), invisible until someone reads unpunctuated text.
      { timeoutMs: 8000 },
    );
    const cleaned = result.trim();
    if (!cleaned) return raw;
    punctuationCache.set(key, cleaned);
    return cleaned;
  } catch {
    return raw;
  }
}

export interface TranscribeOptions {
  // Deadline bounding the auth-session lookup + the transcription upload/
  // response (NOT the trailing addPunctuation call, which is separately
  // bounded). Omit = DEFAULT_AI_TIMEOUT_MS; pass 0 to opt out (unbounded).
  timeoutMs?: number;
}

export async function transcribeAudio(
  uri: string,
  options: TranscribeOptions = {},
): Promise<string> {
  // NEX-280 class: without a deadline, a wedged getSession() or a stalled
  // multipart upload strands the caller's spinner forever. The Command orb
  // path races this with its own 12s external timeout + recognizer fallback,
  // but voice-journal has no external timeout — a hang leaves it in
  // 'processing' until the app is killed. Bound both phases here.
  const totalBudget = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  const startedAt = Date.now();
  const { headers, diagnostics, generation } = await getHeaders(
    'application/json',
    totalBudget ? Math.min(SESSION_LOOKUP_CAP_MS, totalBudget) : undefined,
  );
  // Remove Content-Type for multipart — fetch sets it automatically
  delete headers['Content-Type'];

  const formData = new FormData();
  formData.append('file', { uri, name: 'audio.m4a', type: 'audio/m4a' } as any);
  formData.append('model', 'whisper-1');

  const fetchBudget = totalBudget
    ? Math.max(MIN_FETCH_BUDGET_MS, totalBudget - (Date.now() - startedAt))
    : undefined;
  const controller = fetchBudget ? new AbortController() : undefined;
  let timedOut = false;
  const timer =
    controller && fetchBudget
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, fetchBudget)
      : undefined;

  // Same stale-JWT recovery as chatCompletion. `headers` here already had
  // Content-Type deleted for the multipart boundary; the spread preserves
  // that, so the retried upload keeps fetch's auto-generated boundary.
  const onUnauthorized: UnauthorizedRecovery = async (response) => {
    if (!(await isRefreshable401(response))) return null;
    const remaining = totalBudget ? totalBudget - (Date.now() - startedAt) : Infinity;
    if (remaining <= 0) return null;
    const token = await refreshAccessToken(Math.min(SESSION_LOOKUP_CAP_MS, remaining), generation);
    if (!token) return null;
    return { ...headers, Authorization: `Bearer ${token}` };
  };

  let text = '';
  try {
    const response = await fetchWithRetry(getTranscribeUrl(), {
      method: 'POST',
      headers,
      body: formData,
      ...(controller ? { signal: controller.signal } : {}),
    }, { onUnauthorized });

    if (!response.ok) {
      throw new Error('Voice transcription failed');
    }

    const data = await response.json() as any;
    text = data?.text ?? '';
  } catch (err) {
    // Convert OUR deadline abort into the typed error; the flag proves the
    // abort came from this call's timer, not some other abort source.
    if (timedOut && err instanceof Error && err.name === 'AbortError') {
      throw attachDiagnostics(new AiTimeoutError(), diagnostics);
    }
    throw attachDiagnostics(err, diagnostics);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Punctuation runs unbounded by THIS deadline — it has its own 8s cap and
  // degrades to the raw text on any failure (never throws to the caller).
  return addPunctuation(text);
}

export { getChatUrl, getTranscribeUrl };
