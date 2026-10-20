/**
 * useTarget(key) — register a View as a named onboarding anchor.
 *
 * Usage:
 *   <View ref={useTarget('home.coherenceRing')}>...</View>
 *
 * Returns a ref-callback. Attaches to the View on mount; un-registers on
 * unmount (or when the key changes). The returned callback is stable
 * across renders so React doesn't bounce the ref between mounts.
 */

import { useCallback, useEffect, useRef } from 'react';

import { useOnboarding } from './onboarding-context';

export function useTarget(key: string) {
  const { registerTarget, unregisterTarget } = useOnboarding();
  const lastNodeRef = useRef<unknown>(null);

  // Stable ref-callback: react-reconciler calls this with the View on
  // mount, and with `null` on unmount.
  const setRef = useCallback(
    (node: unknown) => {
      lastNodeRef.current = node;
      if (node) {
        registerTarget(key, node);
      } else {
        unregisterTarget(key);
      }
    },
    [key, registerTarget, unregisterTarget]
  );

  // Defensive cleanup on unmount or key change — covers the rare case
  // where the host component unmounts without calling the ref-callback
  // with null first (some custom renderers / 3rd-party Views misbehave).
  useEffect(() => {
    return () => {
      if (lastNodeRef.current !== null) {
        unregisterTarget(key);
        lastNodeRef.current = null;
      }
    };
  }, [key, unregisterTarget]);

  return setRef;
}
