import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';

import {
  REDUCE_MOTION_INITIAL,
  reduceMotionStateFor,
  type ReduceMotionState,
} from '@/src/utils/reduce-motion-policy';

/**
 * Reactive OS "Reduce Motion" preference.
 *
 * Returns the current value AND whether the initial async read has resolved.
 * Consumers that *schedule* motion must gate on `resolved`:
 * `AccessibilityInfo.isReduceMotionEnabled()` is async, so the hook reports
 * `reduceMotion: false` synchronously on first render — acting before
 * `resolved` would let a reduce-motion user see one frame of motion before the
 * preference is known.
 *
 * Unlike Reanimated's `useReducedMotion()` (a startup snapshot that never
 * updates), this subscribes to `reduceMotionChanged` and re-renders on a live
 * toggle in Settings.
 *
 * `confirmed` vs `resolved`, and why both exist. A FAILED read resolves as
 * `{ reduceMotion: false, resolved: true }` on purpose — a one-off
 * `AccessibilityInfo` failure must not strand the app frozen, so transitions
 * still play. That is right for anything the user is waiting on, and wrong for
 * a purely decorative loop, which should fail toward stillness (§1.5 UF-01, and
 * the LEARNINGS 2026-07-24 `rmStale` rule).
 *
 * So `confirmed` is true only when the preference was actually LEARNED — a
 * successful read or a live event. Gate ornament on `confirmed && !reduceMotion`
 * and functional motion on `resolved`. Additive: existing consumers are
 * unaffected.
 */
export function useReduceMotion(): ReduceMotionState {
  const [state, setState] = useState<ReduceMotionState>(REDUCE_MOTION_INITIAL);

  useEffect(() => {
    let mounted = true;
    // Monotonic token: every source (the initial read, each foreground re-read,
    // each live event) advances it. An async read applies its result only if no
    // newer source has fired since it started, so an out-of-order
    // isReduceMotionEnabled() resolution can never clobber a fresher value.
    let token = 0;

    const readAndApply = () => {
      const myToken = ++token;
      AccessibilityInfo.isReduceMotionEnabled()
        .then((enabled) => {
          if (mounted && myToken === token)
            setState(reduceMotionStateFor({ kind: 'read', enabled }));
        })
        .catch(() => {
          // A failed read should not strand the app frozen: treat it as "no
          // reduction known" so functional motion still plays. `confirmed`
          // stays FALSE, so ornament (the serpent's wave) stays off — it fails
          // toward stillness while transitions fail toward playing.
          if (mounted && myToken === token) setState(reduceMotionStateFor({ kind: 'failed' }));
        });
    };

    // Initial read.
    readAndApply();

    // Live events are authoritative immediately; advance the token so any
    // in-flight read is invalidated. (Modern RN/Expo: addEventListener returns a
    // subscription with .remove(); the legacy removeEventListener was removed.)
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      token++;
      if (mounted) setState(reduceMotionStateFor({ kind: 'event', enabled }));
    });

    // iOS may not deliver reduceMotionChanged while the app is backgrounded, so
    // re-sample on foreground (same pattern as the AppState listener in
    // home-screen.tsx). readAndApply's token guard handles out-of-order resolves.
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') readAndApply();
    });

    return () => {
      mounted = false;
      sub.remove();
      appStateSub.remove();
    };
  }, []);

  return state;
}
