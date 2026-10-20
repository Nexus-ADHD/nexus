import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';

/**
 * Reactive OS "Reduce Transparency" preference (iOS).
 *
 * Mirrors the hardened `useReduceMotion` lifecycle (token-ordered reads so an
 * out-of-order async resolution can't clobber a fresher value, a live
 * `reduceTransparencyChanged` subscription, and an AppState 'active' foreground
 * re-read since iOS can drop the event while backgrounded). Returns the current
 * value AND whether the initial async read has resolved, so consumers don't act
 * on the synchronous `false` before the preference is known.
 *
 * Unlike `useReduceMotion`, this is backed by a **module-level singleton** with
 * one shared `AccessibilityInfo` subscription: `Card` consumes it and is
 * high-fan-in (dozens of instances on screen), so a per-component subscription
 * would mean N native listeners. `useSyncExternalStore` fans the single source
 * out to every card.
 */
type RTState = { reduceTransparency: boolean; resolved: boolean };

let snapshot: RTState = { reduceTransparency: false, resolved: false };
const listeners = new Set<() => void>();
let token = 0;
let teardown: (() => void) | null = null;

function emit() {
  for (const l of listeners) l();
}

function apply(next: RTState) {
  // New object identity so useSyncExternalStore detects the change.
  snapshot = next;
  emit();
}

function readAndApply() {
  const myToken = ++token;
  // `teardown !== null` means the store is still active (has subscribers). It
  // bounds a late resolve so an in-flight read can't mutate the snapshot after
  // the last card unmounted — the singleton's equivalent of the hook's
  // `mounted` guard.
  AccessibilityInfo.isReduceTransparencyEnabled()
    .then((enabled) => {
      if (myToken === token && teardown !== null) apply({ reduceTransparency: enabled, resolved: true });
    })
    .catch(() => {
      // A failed read shouldn't strand consumers: treat as "no reduction known".
      if (myToken === token && teardown !== null) apply({ reduceTransparency: false, resolved: true });
    });
}

function start() {
  readAndApply();
  // Live event is authoritative immediately; advance the token to invalidate any
  // in-flight read. iOS-only event; resolves false on Android.
  const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', (enabled) => {
    token++;
    apply({ reduceTransparency: enabled, resolved: true });
  });
  const appStateSub = AppState.addEventListener('change', (next) => {
    if (next === 'active') readAndApply();
  });
  teardown = () => {
    sub.remove();
    appStateSub.remove();
  };
}

function subscribe(onChange: () => void): () => void {
  if (listeners.size === 0) start();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && teardown) {
      teardown();
      teardown = null;
    }
  };
}

function getSnapshot(): RTState {
  return snapshot;
}

export function useReduceTransparency(): RTState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
