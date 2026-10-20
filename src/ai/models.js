// Canonical Nexus AI model routing. Single source of truth shared by the RN
// app (via re-export from src/utils/ai-models.ts) and the Node eval harness.
//
// Pure ESM, ZERO React Native imports, so `node` can import it directly.
//
// Thesis (research/ai-genai/10-nexus-ai-roadmap.md): route by task complexity
// instead of sending every call to one mid-tier model.
//
// ─── NEX-305: this table now describes reality ──────────────────────────────
//
// It previously did not. Of its ten keys, SEVEN were referenced nowhere in the
// app — MANDATE_GENERATION, DEEP_REVIEW, WEEKLY_REVIEW, MONTHLY_REVIEW,
// MORNING_BRIEF, QUICK_PARSE, and DEFAULT itself. Only COMMAND_ROUTER,
// VOICE_PARSE, and DAILY_PULSE were ever passed, and DEFAULT_MODEL aliased
// DAILY_PULSE, so every remaining call silently rode one model (gpt-4o):
// mandate generation, every horizon review, morning brief, Pulse, wisdom,
// voice journal, breakdown steps, notification quotes. NEX-283 caught this for
// the command router alone; NEX-305 finishes the job for the rest and adds a
// test that fails CI if a tier goes unreferenced again.
//
// TWO RULES THIS FILE ENFORCES, both learned the hard way:
//
//   1. DEFAULT is resolved by its OWN key, never aliased to a named tier.
//      `DEFAULT_MODEL = MODELS.DAILY_PULSE` meant re-tiering the daily-pulse
//      surface silently re-routed every uncategorized call in the app. (Two
//      tiers sharing a model *id* is fine and deliberate — WEEKLY_REVIEW and
//      MONTHLY_REVIEW are both mini. It is the *reference* that must not be
//      shared.)
//
//   2. Every id here MUST be proxy-routable. The proxy
//      (supabase/functions/ai-proxy/index.ts) routes by model id prefix:
//      `kimi-*` to Moonshot (api.moonshot.ai, OpenAI-compatible),
//      `claude-*` to Anthropic, and `gpt-*`/`o<N>`/`chatgpt-*` to OpenAI.
//      The previous version of this file carried a `ROUTING.enableClaude`
//      flag gating a `claudeOrOpenAI()` helper; flipping that one boolean
//      looked like a free quality upgrade and would in fact have sent
//      `claude-*` ids to OpenAI and 400'd EVERY AI feature at once — because
//      DEFAULT_MODEL was itself a claudeOrOpenAI entry. That machinery is
//      deleted rather than left disabled: a dormant switch whose "on"
//      position is an outage does not belong in the tree. Provider routing
//      is re-added deliberately (NEX-311 Anthropic, Kimi below), each with
//      its own tests. `assertProxyRoutable` makes an unroutable id fail
//      loudly at the boundary instead of as an opaque upstream 400.

/**
 * Object.freeze restores the runtime immutability the app's prior `as const`
 * implied — `as const` is compile-time only, so freezing the canonical object
 * guards against accidental mutation by any consumer.
 *
 * Provider: every tier routes to Kimi (Moonshot). One model carries the whole
 * table: `kimi-k2.6`. It previously split between `kimi-k2.6` (high-stakes)
 * and `kimi-k2.5` (high-volume), but Moonshot retired `kimi-k2.5` — its
 * served-model list, verified via GET /v1/models on 2026-08-06, is exactly
 * `kimi-k2.6` / `kimi-k3` / `kimi-k2.7-code` / `kimi-k2.7-code-highspeed`,
 * and every `kimi-k2.5` chat call 404s ("model not found"). The proxy keeps a
 * server-side `kimi-k2.5` → `kimi-k2.6` alias (supabase/functions/_shared/
 * kimi-shape.ts, NEX-327) so ALREADY-INSTALLED builds that still send the
 * retired id are fixed by a proxy redeploy, without an app release; this
 * table names the served id directly so new builds never touch the alias.
 * `kimi-k3` (the flagship) is deliberately NOT used: its thinking is
 * always on at max effort, which makes it slow and output-expensive for the
 * interactive surfaces this app is built from. OpenAI stays routable in the
 * proxy for /transcribe (Whisper) and as a fallback a future tier can name.
 */
export const MODELS = Object.freeze({
  /**
   * Command-tab capture routing — the orb's Tier-2 parse (NEX-283). The single
   * most user-facing AI call in the app, so it gets the stronger Kimi model.
   * JSON mode (`response_format: json_object`) is supported on this route.
   */
  COMMAND_ROUTER: 'kimi-k2.6',

  /**
   * Mandate / identity generation — the most important AI moment in the app.
   * Extracts who the user says they want to be from their own free-text
   * reflection. Runs roughly once per user, at onboarding: highest stakes,
   * lowest volume, so the stronger model is the easy call.
   */
  MANDATE_GENERATION: 'kimi-k2.6',

  /**
   * Quarterly / annual / horizon reviews — the deepest synthesis the app does,
   * over the longest window. Rare enough to be cost-insensitive.
   */
  DEEP_REVIEW: 'kimi-k2.6',

  /** Weekly review — pattern synthesis across 7 days. */
  WEEKLY_REVIEW: 'kimi-k2.6',

  /** Monthly review — same shape as weekly, wider window. */
  MONTHLY_REVIEW: 'kimi-k2.6',

  /** Morning brief — needs context and quality, not the deepest reasoning. */
  MORNING_BRIEF: 'kimi-k2.6',

  /** Daily Pulse — contextual recommendations, once a day. */
  DAILY_PULSE: 'kimi-k2.6',

  /** Simple structured extraction (habit name from a sentence, sentiment). */
  QUICK_PARSE: 'kimi-k2.6',

  /** Voice parsing, quick intent extraction. Cheapest viable. */
  VOICE_PARSE: 'kimi-k2.6',

  /**
   * Coach thread (docs/plans/2026-09-02-coach-conversation.md): a multi-turn
   * conversation whose turns can carry a plan of ProposedActions. Needs the
   * context-holding quality of the command router; JSON mode is required.
   */
  COACH: 'kimi-k2.6',

  /**
   * Fallback for a call that names no tier. Consumers must resolve it through
   * THIS key (rule 1) rather than pointing at a named tier, so re-tiering one
   * surface can never move every uncategorized call with it. Prefer naming a
   * tier at the call site over relying on this.
   */
  DEFAULT: 'kimi-k2.6',
});

/**
 * Every tier NAME, in declaration order. Used by the NEX-305 "no dead tiers"
 * test, which greps the app for each name so an unreferenced tier fails CI
 * instead of quietly accumulating.
 * @type {readonly string[]}
 */
export const MODEL_TIER_NAMES = Object.freeze(Object.keys(MODELS));

/**
 * True for ids the OpenAI-passthrough proxy can actually serve.
 *
 * Deliberately an ALLOW-list by prefix rather than a deny-list of known other
 * providers: an unrecognized id should fail closed, not sail through to
 * api.openai.com on the assumption that anything non-Claude must be OpenAI.
 *
 * @param {string} model
 * @returns {boolean}
 */
export function isOpenAIRoutable(model) {
  if (typeof model !== 'string' || model.length === 0) return false;
  // OpenAI chat families: `gpt-*`, the `o<N>` reasoning series (o1, o3, o4, …),
  // and `chatgpt-*`. The `o\d` form is deliberately generic rather than an
  // o1/o3 enumeration so a valid EXPO_PUBLIC_OPENAI_MODEL override on a newer
  // reasoning family (o4-mini and successors) is not rejected before dispatch —
  // the old path sent any string, so the guard must not be stricter than OpenAI
  // itself about which of ITS models are valid. It still fails closed on other
  // providers (claude-*, gemini-*, llama-*), which is the whole point.
  return /^(gpt-|chatgpt-|o\d)/.test(model);
}

/**
 * Throw unless `model` is something the proxy can serve.
 *
 * This is the boundary that makes rule 2 unrepresentable rather than merely
 * documented. Called before dispatching to the proxy so the failure names the
 * real cause ("this id has no route") instead of surfacing as an opaque
 * upstream 400 several layers away.
 *
 * @param {string} model
 * @param {string} [context] Call-site label, included in the message.
 * @returns {string} The validated model id, for inline use.
 */
export function assertOpenAIRoutable(model, context = 'chatCompletion') {
  if (!isOpenAIRoutable(model)) {
    throw new Error(
      `[Nexus] ${context}: model "${model}" is not OpenAI-routable. The AI proxy ` +
        'posts to api.openai.com and has no other provider route, so this call would ' +
        'fail upstream. Add the provider route to supabase/functions/ai-proxy before ' +
        'routing a non-OpenAI model here.',
    );
  }
  return model;
}

/**
 * Anthropic (`claude-*`) models the proxy can now serve.
 *
 * NEX-311 added a real Anthropic route to `supabase/functions/ai-proxy`, which
 * picks its provider by model id. This MIRRORS the proxy's own `isAnthropicModel`
 * (`_shared/anthropic-shape.ts`, `/^claude-/i`). The two predicates live in two
 * runtimes — this app-side JS and the edge-function Deno TS — and cannot share
 * an import, exactly like the widget bridge and its Swift twin. If one changes,
 * change both; the models test pins that the client is never MORE permissive
 * than the proxy.
 *
 * @param {string} model
 * @returns {boolean}
 */
export function isAnthropicRoutable(model) {
  if (typeof model !== 'string' || model.length === 0) return false;
  return /^claude-/i.test(model);
}

/**
 * Kimi / Moonshot (`kimi-*`) models the proxy can serve.
 *
 * Mirrors the proxy's own `isKimiModel` (`_shared/kimi-shape.ts`, `/^kimi-/i`),
 * in the same two-runtime arrangement as the Anthropic predicate above — if
 * one changes, change both. Note `moonshot-v1-*` ids are NOT routed: the
 * client table only ever names `kimi-*`, and a second accepted prefix would
 * be a route the tests don't pin.
 *
 * @param {string} model
 * @returns {boolean}
 */
export function isKimiRoutable(model) {
  if (typeof model !== 'string' || model.length === 0) return false;
  return /^kimi-/i.test(model);
}

/**
 * Can the proxy serve `model` at all, on ANY provider it routes?
 *
 * This is the predicate the dispatch path should gate on. `isOpenAIRoutable`
 * alone was correct only while the proxy was OpenAI-only (pre-NEX-311); using it
 * as the dispatch guard now would reject every `claude-*` id before it left the
 * device, making the Anthropic route unreachable — the route would be live in
 * the proxy and dead from the client. It still fails closed on providers the
 * proxy does NOT route (gemini-*, llama-*, and anything unrecognized).
 *
 * @param {string} model
 * @returns {boolean}
 */
export function isProxyRoutable(model) {
  return isOpenAIRoutable(model) || isAnthropicRoutable(model) || isKimiRoutable(model);
}

/**
 * Throw unless the proxy can serve `model` on some provider.
 *
 * Supersedes `assertOpenAIRoutable` at the dispatch boundary now that the proxy
 * routes more than OpenAI. Called before dispatch so the failure names the real
 * cause ("no provider route") rather than surfacing as an opaque upstream 400.
 *
 * @param {string} model
 * @param {string} [context] Call-site label, included in the message.
 * @returns {string} The validated model id, for inline use.
 */
export function assertProxyRoutable(model, context = 'chatCompletion') {
  if (!isProxyRoutable(model)) {
    throw new Error(
      `[Nexus] ${context}: model "${model}" has no proxy route. The AI proxy ` +
        'routes gpt-* / o<N> / chatgpt-* to OpenAI, claude-* to Anthropic, and ' +
        'kimi-* to Moonshot; this id matches none of them, so the call would ' +
        'fail upstream. Add the provider route to supabase/functions/ai-proxy ' +
        'before routing it here.',
    );
  }
  return model;
}
