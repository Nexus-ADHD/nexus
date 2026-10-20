/**
 * Mandate Strengthen — pure suggestion-fetch policy.
 *
 * Extracted from mandate-strengthen-sheet.tsx (RN component, not importable
 * by this repo's pure-Node vitest) so the parse + retry policy is unit-
 * testable. Nothing here touches React, AsyncStorage, or the app store —
 * the caller injects `chat` (the RN component passes `chatCompletion`).
 *
 * Policy fixes over the pre-extraction version:
 *  - json_object response_format + a max_tokens cap, so the model is far
 *    less likely to return truncated/non-JSON text (the parse-failure path
 *    existed largely to paper over that).
 *  - timeout raised 15s -> 30s to match ai-client's DEFAULT_AI_TIMEOUT_MS —
 *    the proxy allows 60s upstream, so 15s was aborting slow-but-valid
 *    generations.
 *  - ONE silent retry, shared between a parse failure and a fast-thrown
 *    error (a proxy/API failure that returns quickly), bounded by the
 *    REMAINING budget rather than a fresh 30s — a slow first attempt can't
 *    balloon the wait to ~60s, and a first attempt that already ate most of
 *    the budget skips the retry and surfaces the failure immediately.
 *  - AiTimeoutError/SessionTimeoutError are NEVER retried — the user
 *    already waited the full budget once; a silent second wait is worse
 *    than showing RETRY.
 *  - valid JSON with both arrays empty is a real (if disappointing) result,
 *    not a parse failure — it no longer burns the retry or the error copy.
 */
import { MODELS } from '@/src/ai/models';

export interface SuggestedItem {
  title: string;
  rationale: string;
}

export interface SuggestionPayload {
  habits: SuggestedItem[];
  todos: SuggestedItem[];
}

export interface StrengthenChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface StrengthenChatOptions {
  model?: string;
  response_format?: { type: 'json_object' };
  max_tokens?: number;
  timeoutMs?: number;
}

/** Matches the chatCompletion signature in src/utils/ai-client.ts. */
export type ChatFn = (
  messages: StrengthenChatMessage[],
  options?: StrengthenChatOptions,
) => Promise<string>;

// A single `kind` string discriminant, not a boolean `ok` flag — with
// strictNullChecks:false (this repo's tsconfig.json), TS fails to narrow a
// boolean-literal discriminant (`ok: true` / `ok: false`) in the negative
// branch of an if/else; a string-literal discriminant narrows correctly
// either way. Reproduce in this repo with:
//   type R = { ok: true; payload: string } | { ok: false; kind: 'a' };
//   declare const r: R;
//   if (r.ok) { r.payload; } else { r.kind; } // TS2339 under this tsconfig
// (Isolated by A/B: the same snippet compiles clean with
// --strictNullChecks true; the failure requires strictNullChecks false, not
// strict:false generally.)
export type StrengthenResult =
  | { kind: 'ok'; payload: SuggestionPayload }
  | { kind: 'parse' }
  | { kind: 'timeout' }
  | { kind: 'failed' };

// Mirrors ai-client's DEFAULT_AI_TIMEOUT_MS. Not imported directly — this
// module stays free of ai-client's supabase/public-config transitive
// imports so it (and its tests) never touch RN/Expo config resolution.
export const STRENGTHEN_TIMEOUT_MS = 30000;

// 3 habits + 2 todos with one-sentence rationales fits comfortably; this is
// headroom against truncation (a cut-off response is invalid JSON, which
// would otherwise burn the retry on a length limit rather than a real miss).
const MAX_TOKENS = 800;

// A retry attempt given less than this isn't worth starting — the model call
// alone rarely completes in under a couple seconds, so surface the failure
// instead of firing a retry near-certain to time out immediately.
const MIN_RETRY_BUDGET_MS = 4000;

/**
 * Valid JSON with empty habits/todos is a real (if disappointing) result —
 * it renders the sheet's empty-state UI, not the error state. `null` means
 * the response was not usable at all (invalid JSON, wrong shape).
 */
export function parsePayload(raw: string): SuggestionPayload | null {
  if (!raw) return null;
  const cleaned = raw.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.warn('[strengthen] JSON parse failed:', (e as Error)?.message);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const habits = Array.isArray(record.habits)
    ? record.habits
        .map((h: any) => ({
          title: String(h?.title ?? '').trim(),
          rationale: String(h?.rationale ?? '').trim(),
        }))
        .filter((h: SuggestedItem) => h.title.length > 0)
        .slice(0, 3)
    : [];
  const todos = Array.isArray(record.todos)
    ? record.todos
        .map((t: any) => ({
          title: String(t?.title ?? '').trim(),
          rationale: String(t?.rationale ?? '').trim(),
        }))
        .filter((t: SuggestedItem) => t.title.length > 0)
        .slice(0, 2)
    : [];
  return { habits, todos };
}

// AiTimeoutError/SessionTimeoutError are duck-typed by `.name` (the same
// pattern ai-client itself uses for AbortError) so this module never needs
// to import ai-client's error classes or its supabase/public-config chain.
function isTimeoutError(e: unknown): boolean {
  const name = e instanceof Error ? e.name : '';
  return name === 'AiTimeoutError' || name === 'SessionTimeoutError';
}

export async function fetchStrengthenSuggestions(
  prompt: { system: string; user: string },
  chat: ChatFn,
): Promise<StrengthenResult> {
  const startedAt = Date.now();

  const attempt = async (timeoutMs: number): Promise<StrengthenResult> => {
    try {
      const raw = await chat(
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        {
          model: MODELS.DAILY_PULSE,
          response_format: { type: 'json_object' },
          max_tokens: MAX_TOKENS,
          timeoutMs,
        },
      );
      const parsed = parsePayload(raw);
      return parsed ? { kind: 'ok', payload: parsed } : { kind: 'parse' };
    } catch (e) {
      if (isTimeoutError(e)) return { kind: 'timeout' };
      console.warn('[strengthen] chatCompletion failed:', (e as Error)?.message ?? e);
      return { kind: 'failed' };
    }
  };

  const first = await attempt(STRENGTHEN_TIMEOUT_MS);
  // 'ok' needs no retry; 'timeout' is never retried (the user already waited
  // the full budget once). Only 'parse' / 'failed' fall through to the retry.
  if (first.kind === 'ok' || first.kind === 'timeout') return first;

  const remaining = STRENGTHEN_TIMEOUT_MS - (Date.now() - startedAt);
  if (remaining < MIN_RETRY_BUDGET_MS) return first;

  return attempt(remaining);
}
