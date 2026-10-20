// supabase/functions/_shared/sentry.ts — NEX-134
//
// Server-side error capture for the critical edge functions, so a prod
// regression on a money/auth/data path surfaces in Sentry (and the
// `critical_path` issue-alert emails) in minutes — not via a 1★ review.
//
// IMPORT SHAPE (learned the hard way — verified against a live deploy):
//  - STATIC `import` from esm.sh, so the Supabase deploy BUNDLES the SDK into
//    the function. An earlier *lazy, non-literal* `import(varURL)` passed
//    `deno check` but could NOT be bundled (the bundler can't resolve a
//    variable specifier), so at runtime the edge isolate had no SDK and capture
//    silently no-opped — a deployed test error produced ZERO Sentry events.
//    A static esm.sh import is the proven pattern here (ai-proxy bundles
//    `braintrust` the same way and it works in prod).
//  - `// @deno-types="./sentry-shim.d.ts"` makes `deno check` use a tiny local
//    shim instead of fetching the SDK's published `.d.ts`, which references
//    `npm:@types/node` (unresolvable in CI's node_modules mode).
//
// COST/NEX-89: a static import means the SDK is evaluated at every cold start
// (bundled JS — no network). That is the same class as ai-proxy's existing
// static `braintrust` import. `Sentry.init` is still LAZY + DSN-gated (only on
// the first error), and capture runs ONLY in error branches, fire-and-forget
// under `EdgeRuntime.waitUntil`, so the verbatim ai-proxy passthrough is never
// altered, delayed, or thrown into (NEX-89 preserved).
//
// NO PII: `defaultIntegrations:false` (the Deno SDK does not auto-scope
// `Deno.serve`, so default breadcrumbs/request context could bleed across
// reused isolates) + `sendDefaultPii:false` + `beforeSend` strips
// `user`/`request`. Callers pass ONLY ids/enums/status-codes in `extra`.
//
// DSN via the `SENTRY_EDGE_DSN` Supabase secret (its value is the app Sentry
// project's DSN — one project, edge events tagged `edge_function`). Empty ⇒ no-op.

// @deno-types="./sentry-shim.d.ts"
import * as Sentry from 'https://esm.sh/@sentry/deno@10.60.0';

const dsn = Deno.env.get('SENTRY_EDGE_DSN') ?? '';

let inited = false;
let initFailed = false;

// Lazily init on the first error so the happy path pays no init cost. Returns
// whether Sentry is usable. Never throws (a telemetry failure must be invisible).
function ensureInit(): boolean {
  if (inited) return true;
  if (initFailed || dsn.length === 0) return false;
  try {
    Sentry.init({
      dsn,
      defaultIntegrations: false,
      tracesSampleRate: 0,
      sendDefaultPii: false,
      // deno-lint-ignore no-explicit-any
      beforeSend(event: any) {
        delete event.user;
        delete event.request;
        return event;
      },
    });
    inited = true;
    return true;
  } catch (_e) {
    initFailed = true; // latch off — don't retry a failing init on every error
    return false;
  }
}

export interface EdgeErrorCtx {
  /** The function name, set as the `edge_function` tag. */
  fn: string;
  /**
   * Money/auth/data path. Sets the `critical_path: 'true'` string tag that the
   * NEX-134 issue-alert fires on. High-volume non-critical paths (ai-proxy)
   * leave this false so their noise never enters the alert.
   */
  criticalPath?: boolean;
  /** ids / enums / status-codes / operational error strings ONLY. NEVER PII. */
  extra?: Record<string, unknown>;
}

async function doCapture(err: unknown, ctx: EdgeErrorCtx): Promise<void> {
  if (!ensureInit()) return;
  Sentry.withScope((scope) => {
    scope.setTag('edge_function', ctx.fn);
    if (ctx.criticalPath) scope.setTag('critical_path', 'true');
    if (ctx.extra) scope.setExtras(ctx.extra);
    Sentry.captureException(err);
  });
  await Sentry.flush(2000);
}

/**
 * Capture an edge-function error. Fire-and-forget: never awaited in the request
 * path, never throws, never delays the response. The whole capture+flush is
 * handed to `EdgeRuntime.waitUntil` so it survives isolate teardown.
 */
export function captureEdgeError(err: unknown, ctx: EdgeErrorCtx): void {
  try {
    const pending = doCapture(err, ctx).catch(() => {
      /* swallow — telemetry failure must be invisible to the caller */
    });
    // @ts-ignore EdgeRuntime is a Supabase Deno runtime global, not in Deno types.
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(pending);
    }
  } catch (_e) {
    /* never throw from telemetry */
  }
}
