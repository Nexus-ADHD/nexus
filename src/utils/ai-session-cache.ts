/**
 * ai-session-cache.ts — the last access token a successful auth lookup
 * produced, kept so a lookup that wedges does not cost the AI call.
 *
 * Coach, builds 255/256: every turn failed while the proxy never saw a
 * request; the only pre-network step, `supabase.auth.getSession()`, was
 * holding past its 6s cap while auth-js waited on its own refresh. The
 * previous token is still a good bearer (the proxy verifies it with GoTrue,
 * and a stale one gets ai-client's 401 refresh + retry), so ai-client reuses
 * it and records that it did.
 *
 * Dependency-free on purpose: ai-client, app-state (resetState) and
 * sign-out all import it, and none of them may import each other for this.
 *
 * Identity boundary. The cache is cleared on sign-out, AND every clear bumps
 * a generation that in-flight lookups carry: a `getSession()` account A
 * started before signing out can resolve after the clear, and without the
 * generation check it would put A's token back for account B's first wedged
 * call (Greptile T-Rex, PR #488). A resolved token is stored only when the
 * generation it was requested under is still the current one.
 */

let lastKnownAccessToken: string | null = null;
let generation = 0;

/** The current auth generation; capture it BEFORE starting a session lookup. */
export function aiSessionGeneration(): number {
  return generation;
}

/**
 * Store a resolved token, unless a sign-out happened since the lookup began
 * (`startedIn` is the generation captured before the lookup).
 */
export function rememberAccessToken(token: string | null | undefined, startedIn: number): void {
  if (startedIn !== generation) return;
  if (typeof token === 'string' && token) lastKnownAccessToken = token;
}

export function lastKnownAccessTokenOrNull(): string | null {
  return lastKnownAccessToken;
}

/** Sign-out and resetState: the next person's calls must never reuse this token. */
export function clearAiSessionCache(): void {
  lastKnownAccessToken = null;
  generation += 1;
}
