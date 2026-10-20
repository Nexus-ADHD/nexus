import { useEffect, useMemo, useRef } from 'react';

/**
 * useVoiceCaptureGuards — the shared re-entrancy + lifecycle guard for the three
 * voice-capture screens (Command orb `handleVoiceOrbPress`, Structured Start
 * `handleSpeakPress`, First-Win Capture `handleOrbPress`). It centralizes ONLY
 * the async-race-prone primitive those screens independently hand-rolled (and
 * that the NEX-193 / NEXUS-5 work hardened), so the logic can no longer drift
 * copy-to-copy:
 *
 *   - `lockWhile(fn)` claims a synchronous in-flight lock BEFORE awaiting `fn`
 *     and releases it in `finally`, so a fast double-tap can't fire two
 *     concurrent recognizer `start()`/`stop()` calls — two AVAudioSession
 *     activations strand the recognizer (the NEXUS-5 "tap does nothing until a
 *     refresh" hang).
 *   - `isMounted()` reports liveness so a `start()` that resolves AFTER unmount
 *     can be torn down by the caller instead of calling setState on an
 *     unmounted screen (the NEX-193 skip-during-startup leak).
 *
 * Everything screen-specific stays in the caller and is intentionally NOT
 * modelled here: the `continuous` flag, the post-stop processing-hold timer
 * (absent on the orb, 800ms on Structured Start, 400ms on First-Win), the
 * expo-av audio-session reset (absent on Structured Start), success actions,
 * orb/voice state shape, haptics, and analytics. Pass an `onUnmount` callback
 * for each screen's own teardown (stop the recognizer, clear timers, reset the
 * audio session).
 */
export interface VoiceCaptureGuards {
  /** True while a `lockWhile` call is in flight. Synchronous, ref-backed. */
  isInFlight: () => boolean;
  /** True while the host component is mounted. */
  isMounted: () => boolean;
  /**
   * Claim the in-flight lock, run `fn`, release it in `finally`, and resolve to
   * `fn`'s value. Callers MUST early-return on `isInFlight()` first — every
   * voice screen does, synchronously, so it can reject a double-tap BEFORE any
   * side effect (haptic / state). With that pre-check there is no await between
   * the guard and this claim, so this is never entered re-entrantly.
   */
  lockWhile: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function useVoiceCaptureGuards(onUnmount?: () => void): VoiceCaptureGuards {
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  // Keep the latest onUnmount so the mount-once cleanup runs the current
  // teardown closure (the screens close over stable refs/functions today, so
  // this preserves their exact unmount behavior without a changing-deps effect).
  const onUnmountRef = useRef(onUnmount);
  onUnmountRef.current = onUnmount;

  useEffect(() => {
    // Re-arm on mount so a StrictMode setup→cleanup→setup cycle (dev) leaves the
    // ref true rather than stranded false (Structured Start already did this;
    // the orb and First-Win did not — re-arming is strictly more correct and
    // a no-op in production).
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onUnmountRef.current?.();
    };
    // Mount-once: the lock + mount lifecycle is keyed to the component instance.
  }, []);

  // Build the interface once: every method only reads stable refs, so returning
  // a fresh object + closures each render would be pure allocation / GC churn
  // (Structured Start re-renders on every countdown tick).
  return useMemo<VoiceCaptureGuards>(() => ({
    isInFlight: () => inFlightRef.current,
    isMounted: () => mountedRef.current,
    lockWhile: async (fn) => {
      inFlightRef.current = true;
      try {
        return await fn();
      } finally {
        inFlightRef.current = false;
      }
    },
  }), []);
}
