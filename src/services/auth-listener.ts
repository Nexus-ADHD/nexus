/**
 * auth-listener.ts — the one rule for `supabase.auth.onAuthStateChange`.
 *
 * auth-js AWAITS every subscriber callback (`_notifyAllSubscribers`) while it
 * holds its session lock, including during `_initialize` → `_recoverAndRefresh`
 * on a cold start with an expired token. A callback that itself awaits a
 * Supabase call (`supabase.from(...)` → `getSession()` → `await
 * initializePromise`) waits for the very lock the library is holding while it
 * waits for the callback. Nothing ever resolves.
 *
 * That was the coach on builds 255 to 257: the server showed the token refresh
 * landing at the exact second the app launched, and every `getSession()` for
 * the rest of the process hit the 6s cap (`session-timeout`). It only bit on
 * the first launch after a long idle, because a fresh token skips the network
 * refresh and the init lock is released before the listener even subscribes.
 *
 * The rule, from the Supabase docs and now from this file: the subscriber
 * returns synchronously and hands its work to the next tick.
 *
 * Deferring has a cost auth-js's awaiting used to pay for us: events no longer
 * run one at a time, so a SIGNED_IN handler suspended in a cloud restore can
 * resume AFTER a later SIGNED_OUT (or another account's SIGNED_IN) and write
 * the old account's state (Greptile T-Rex, PR #490). Every event therefore
 * bumps a transition generation, and the handler receives `isCurrent()`: it
 * must check it after every await before touching app state, and stop when
 * a newer transition has superseded it.
 */

export interface AuthTransition {
  /** True while no newer auth event has arrived since this handler's event. */
  isCurrent: () => boolean;
  /** The generation of this handler's event (for breadcrumbs). */
  generation: number;
}

export type AuthStateHandler<E, S> = (event: E, session: S, transition: AuthTransition) => Promise<void>;

/**
 * Wrap an async auth handler so the subscriber auth-js awaits returns at
 * once. The handler runs on the next macrotask, after the library has
 * released its lock, with a transition token that goes stale the moment a
 * newer event arrives; a rejection is reported to `onError` (never rethrown
 * into auth-js, which would console.error and drop it).
 */
export function deferredAuthListener<E, S>(
  handler: AuthStateHandler<E, S>,
  onError: (err: unknown) => void = () => {},
): (event: E, session: S) => void {
  let generation = 0;
  return (event, session) => {
    generation += 1;
    const mine = generation;
    const transition: AuthTransition = { isCurrent: () => mine === generation, generation: mine };
    setTimeout(() => {
      // Two events queued back to back run in order, so a superseded one
      // would still execute its synchronous prefix (setAuthState) before
      // its first isCurrent() check and briefly restore stale auth state
      // (Greptile T-Rex round 3). A superseded event never enters the handler.
      if (!transition.isCurrent()) return;
      let p: Promise<void>;
      try {
        p = handler(event, session, transition);
      } catch (err) {
        onError(err);
        return;
      }
      p.catch(onError);
    }, 0);
  };
}
