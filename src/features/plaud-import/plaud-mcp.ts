import { PLAUD_MCP_URL } from './plaud-auth-core';
import type { PlaudTranscriptSegment, PlaudTranscriptSource } from './types';
import {
  MAX_RETRY_ATTEMPTS,
  RETRY_BACKOFF_MS,
  RETRYABLE_HTTP_STATUSES,
  retryDelayMs,
  sleep,
} from '../../utils/retry-policy';

export const PLAUD_MCP_PROTOCOL_VERSION = '2025-06-18';
export const PLAUD_RECORDING_PAGE_SIZE = 20;
export const PLAUD_MAX_TRANSCRIPT_SEGMENTS = 2_000;
export const PLAUD_MAX_TRANSCRIPT_CHARS = 60_000;
const PLAUD_TRANSCRIPT_PAGE_SIZE = 250;
const PLAUD_MAX_TRANSCRIPT_PAGES = 20;
const MCP_TIMEOUT_MS = 30_000;

export interface PlaudRecording {
  id: string;
  title: string;
  recordedAt: string;
  durationMs?: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type JsonRpcResponse = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

type PlaudToolResult = {
  content?: unknown;
  isError?: unknown;
};

/**
 * The caller's deadline was already spent before a request could be started.
 *
 * Distinct from a timeout: nothing was sent. The budget arithmetic clamped a
 * non-positive remaining budget up to the minimum attempt and fired a doomed
 * request anyway, which both defeated the caller's deadline and spent an
 * authenticated call against PLAUD that could not possibly succeed. PLAUD
 * asked us to keep access minimal, so an impossible request is not free.
 */
export class PlaudDeadlineError extends Error {
  constructor() {
    super('PLAUD did not respond in time.');
    this.name = 'PlaudDeadlineError';
  }
}

/**
 * A transport-level failure: the request never produced a response we could
 * read. Distinct from a malformed or rejected response, which is deterministic
 * and must fail immediately.
 */
export class PlaudNetworkError extends Error {
  constructor(public readonly cause: unknown) {
    super('Could not reach PLAUD.');
    this.name = 'PlaudNetworkError';
  }
}

export class PlaudMcpHttpError extends Error {
  /**
   * Parsed from the response's `Retry-After` when present, so the retry loop
   * can wait the server's number instead of guessing. Undefined otherwise.
   */
  constructor(
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(`PLAUD request failed (${status}).`);
    this.name = 'PlaudMcpHttpError';
  }
}

export class PlaudTranscriptTooLargeError extends Error {
  constructor() {
    super('This recording is too long for the first PLAUD import slice.');
    this.name = 'PlaudTranscriptTooLargeError';
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function parseSseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      throw new Error('PLAUD returned malformed event data.');
    }
  }
  return messages;
}

export function parsePlaudJsonRpcResponse(
  text: string,
  contentType: string | null,
  requestId: number,
): unknown {
  let values: unknown[];
  if (contentType?.toLowerCase().includes('text/event-stream')) {
    values = parseSseMessages(text);
  } else {
    try {
      const parsed = JSON.parse(text);
      values = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new Error('PLAUD returned malformed JSON.');
    }
  }

  const response = values
    .map((value) => value as JsonRpcResponse)
    .find((value) => value && value.id === requestId);
  if (!response) throw new Error('PLAUD returned no matching response.');
  const rpcError = object(response.error);
  if (rpcError) {
    const message = typeof rpcError.message === 'string' ? rpcError.message : 'PLAUD MCP error.';
    throw new Error(message);
  }
  return response.result;
}

export function parsePlaudToolText(resultValue: unknown): string {
  const result = object(resultValue) as PlaudToolResult | null;
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .map((item) => object(item))
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => String(item?.text))
    .join('\n');
  if (result?.isError === true) {
    throw new Error(text || 'PLAUD tool call failed.');
  }
  if (!text) throw new Error('PLAUD tool returned no text.');
  return text;
}

let nextRequestId = 1;

/**
 * Total wall-clock budget across all attempts.
 *
 * MCP_TIMEOUT_MS bounds ONE attempt; three of those back to back would be ~90s
 * of spinner, which is worse than failing. The budget caps the whole sequence
 * and also shrinks each attempt's own timeout to whatever is left, so a retry
 * can never push past it.
 */
const MCP_TOTAL_BUDGET_MS = 45_000;

/** Don't start another attempt with less runway than this left. */
const MCP_MIN_ATTEMPT_MS = 2_000;

/** Cap on an honored Retry-After, so a large value can't hang the screen. */
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * How long ONE attempt may take, given the budget left and how many attempts
 * are still allowed.
 *
 * This exists because a fixed per-attempt timeout silently disabled retrying
 * wherever the caller's own deadline was shorter than it. The PLAUD import
 * screen bounds its whole load at a few seconds; the per-attempt timeout was
 * 30s; so the screen always aborted while attempt 1 was still in flight and
 * no retry ever ran. The budget has to be divided, not assumed.
 *
 * The backoff still owed between the remaining attempts is reserved first, so
 * the waiting cannot eat the time the attempts need.
 */
export function attemptTimeoutMs(
  remainingMs: number,
  attemptsLeft: number,
  perAttemptCap: number = MCP_TIMEOUT_MS,
): number {
  if (remainingMs <= 0) return 0;
  // The floor is min(MIN, remaining), never MIN outright. Flooring at a flat
  // 2000ms when only 1500ms remained would hand back a timeout LONGER than the
  // caller's deadline, which is the same mistake as the fixed 30s this
  // function replaced, just smaller.
  const floor = Math.min(MCP_MIN_ATTEMPT_MS, remainingMs);
  const ceiling = Math.min(perAttemptCap, remainingMs);
  if (attemptsLeft <= 1) return ceiling;
  const owedBackoff = RETRY_BACKOFF_MS
    .slice(0, attemptsLeft - 1)
    .reduce((total, ms) => total + ms, 0);
  const usable = Math.max(0, remainingMs - owedBackoff);
  const share = Math.floor(usable / attemptsLeft);
  return Math.max(floor, Math.min(ceiling, share));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * `Retry-After` in seconds or as an HTTP date. PLAUD asked us to handle rate
 * limits properly, and the server's own number beats our guess when present.
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
}

/**
 * One PLAUD tool call, with retry and backoff on rate limits and transient
 * server/network errors.
 *
 * 401 is deliberately NOT retried here: it means the access token expired, and
 * `plaud-client.ts` handles it a layer up by refreshing and reissuing. Other
 * 4xx are our own bad request and would fail identically, so they fail fast.
 */
export async function callPlaudToolWithToken(
  accessToken: string,
  name: 'list_files' | 'get_transcript' | 'get_current_user',
  args: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
  budgetMs: number = MCP_TOTAL_BUDGET_MS,
): Promise<string> {
  const startedAt = Date.now();
  // Reject ONLY a genuinely spent budget. An earlier version rejected anything
  // under the two-second minimum, which meant a caller with 1500ms of real time
  // left was told PLAUD had not responded before its deadline had even elapsed
  // — giving up early rather than failing honestly. Positive time is time; the
  // attempt is bounded by it instead.
  if (budgetMs <= 0) throw new PlaudDeadlineError();
  const budget = budgetMs;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    const remaining = budget - (Date.now() - startedAt);
    // Deliberately a different threshold from the entry guard above. Starting
    // the FIRST attempt with any positive time is right; spending a RETRY on a
    // sliver is a request against PLAUD that will not land, and they asked us
    // to keep access minimal.
    if (attempt > 0 && remaining < MCP_MIN_ATTEMPT_MS) break;

    try {
      return await attemptPlaudTool(
        accessToken,
        name,
        args,
        fetchImpl,
        attemptTimeoutMs(remaining, MAX_RETRY_ATTEMPTS - attempt),
      );
    } catch (error) {
      lastError = error;

      // An ALLOWLIST on purpose. Only these three can plausibly differ on a
      // second identical request; everything else — a malformed body, a
      // JSON-RPC protocol error, a mismatched response id, a tool-level
      // rejection — is deterministic and must surface immediately rather than
      // cost three authenticated PLAUD calls to reach the same failure.
      const retryable =
        error instanceof PlaudMcpHttpError
          ? RETRYABLE_HTTP_STATUSES.has(error.status)
          : error instanceof PlaudNetworkError ||
            // An abort here is always OUR per-attempt deadline: this function
            // takes no caller signal, so there is no cancellation to respect.
            // A hung request is the failure the user actually reported, so it
            // is worth another try. (ai-client must NOT do this — its callers
            // pass their own timeout, where an abort is a real deadline.)
            isAbortError(error);
      if (!retryable || attempt >= MAX_RETRY_ATTEMPTS - 1) throw error;

      const serverDelay =
        error instanceof PlaudMcpHttpError ? error.retryAfterMs : undefined;
      const delay = serverDelay ?? retryDelayMs(attempt);

      // Only wait if the budget can still fit an attempt afterwards.
      const left = budget - (Date.now() - startedAt);
      if (delay + MCP_MIN_ATTEMPT_MS > left) throw error;
      await sleep(delay);
    }
  }

  throw lastError ?? new Error('PLAUD request failed.');
}

async function attemptPlaudTool(
  accessToken: string,
  name: 'list_files' | 'get_transcript' | 'get_current_user',
  args: Record<string, unknown>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  const requestId = nextRequestId++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await sendRequest(fetchImpl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PLAUD_MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: controller.signal,
    });
    const text = await readBody(response);
    if (!response.ok) {
      throw new PlaudMcpHttpError(
        response.status,
        parseRetryAfterMs(response.headers.get('retry-after')),
      );
    }
    // Past this line every throw is DETERMINISTIC: we got a response and could
    // not make sense of it. An identical request produces an identical bad
    // response, so these must not be retried.
    return parsePlaudToolText(
      parsePlaudJsonRpcResponse(text, response.headers.get('content-type'), requestId),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The fetch itself. A throw here is a genuine transport failure (DNS, socket,
 * TLS, offline) and can succeed on a second try, so it is tagged as such —
 * that tag is what makes the retry decision an allowlist rather than "any
 * Error", which would sweep in deterministic parse failures.
 */
async function sendRequest(fetchImpl: FetchLike, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(PLAUD_MCP_URL, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new PlaudNetworkError(error);
  }
}

/** Reading the body can fail mid-stream, which is transient like the fetch. */
async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new PlaudNetworkError(error);
  }
}

function asFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const numeric = asFiniteNumber(value);
  const date = numeric === undefined
    ? new Date(String(value))
    : new Date(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function projectPlaudRecordings(toolText: string): PlaudRecording[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolText);
  } catch {
    throw new Error('PLAUD returned an invalid recording list.');
  }
  const payload = object(parsed);
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.flatMap((value) => {
    const item = object(value);
    const id = typeof item?.id === 'string' ? item.id : '';
    const title = typeof item?.name === 'string' ? item.name.trim() : '';
    const recordedAt = asIsoDate(item?.start_at) ?? asIsoDate(item?.created_at);
    if (!id || !recordedAt) return [];
    const duration = asFiniteNumber(item?.duration);
    return [{
      id,
      title: title || 'Untitled PLAUD recording',
      recordedAt,
      ...(duration === undefined ? {} : { durationMs: duration }),
    }];
  });
}

type TranscriptPage = {
  nextCursor: string | null;
  segments: PlaudTranscriptSegment[];
};

export function parsePlaudTranscriptPage(toolText: string): TranscriptPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolText);
  } catch {
    throw new Error('PLAUD returned an invalid transcript page.');
  }
  const payload = object(parsed);
  if (!payload || !Array.isArray(payload.segments)) {
    throw new Error('This PLAUD recording has no timestamped transcript yet.');
  }
  const offset = asFiniteNumber(payload.offset) ?? 0;
  const segments = payload.segments.flatMap((value, pageIndex) => {
    const item = object(value);
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    if (!content) return [];
    const startMs = asFiniteNumber(item?.start_time);
    const endMs = asFiniteNumber(item?.end_time);
    const speakerValue = item?.speaker;
    const speaker =
      typeof speakerValue === 'string' || typeof speakerValue === 'number'
        ? String(speakerValue)
        : undefined;
    return [{
      index: offset + pageIndex,
      content,
      ...(startMs === undefined ? {} : { startMs }),
      ...(endMs === undefined ? {} : { endMs }),
      ...(speaker ? { speaker } : {}),
    }];
  });
  return {
    nextCursor: typeof payload.next_cursor === 'string' && payload.next_cursor
      ? payload.next_cursor
      : null,
    segments,
  };
}

function transcriptLine(segment: PlaudTranscriptSegment): string {
  const start = segment.startMs === undefined ? '' : `|${segment.startMs}`;
  const speaker = segment.speaker ? `|${segment.speaker}` : '';
  return `[${segment.index}${start}${speaker}] ${segment.content}`;
}

export async function fetchPlaudTranscriptSource(
  recording: PlaudRecording,
  callTool: (name: 'get_transcript', args: Record<string, unknown>) => Promise<string>,
): Promise<PlaudTranscriptSource> {
  const segments: PlaudTranscriptSegment[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let transcriptChars = 0;

  for (let pageNumber = 0; pageNumber < PLAUD_MAX_TRANSCRIPT_PAGES; pageNumber += 1) {
    const text = await callTool('get_transcript', {
      file_id: recording.id,
      block: 'transaction',
      limit: PLAUD_TRANSCRIPT_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const page = parsePlaudTranscriptPage(text);
    for (const segment of page.segments) {
      const lineLength = transcriptLine(segment).length + 1;
      if (
        segments.length >= PLAUD_MAX_TRANSCRIPT_SEGMENTS ||
        transcriptChars + lineLength > PLAUD_MAX_TRANSCRIPT_CHARS
      ) {
        throw new PlaudTranscriptTooLargeError();
      }
      segments.push(segment);
      transcriptChars += lineLength;
    }
    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('PLAUD transcript pagination repeated a cursor.');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (pageNumber === PLAUD_MAX_TRANSCRIPT_PAGES - 1) {
      throw new PlaudTranscriptTooLargeError();
    }
  }

  if (!segments.length) throw new Error('This PLAUD recording has no transcript yet.');
  return {
    id: recording.id,
    provider: 'plaud',
    title: recording.title,
    recordedAt: recording.recordedAt,
    transcript: segments.map(transcriptLine).join('\n'),
    segments,
  };
}
