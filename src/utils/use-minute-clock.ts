import { useEffect, useState } from 'react';

/**
 * useMinuteClock — a shared, process-wide minute ticker.
 *
 * One global `setInterval` drives EVERY subscriber, so all time-display widgets
 * update on the SAME tick AND read the SAME `currentMinute` snapshot (no
 * per-widget drift near an event boundary). The interval only runs while at
 * least one component is subscribed.
 *
 * This scopes the Home minute tick: instead of a 60s `setInterval` in the
 * ~3120-line HomeScreen (which re-rendered the whole tree every minute), only
 * the leaf widgets that display time (the UP NEXT card, the events-left count)
 * subscribe here and re-render. Mirrors Orbit's "tiny child owns the tick".
 *
 * State lives on `globalThis` so a dev Fast Refresh (module re-eval) reuses the
 * same interval + subscriber set rather than orphaning the previous interval —
 * the leak class CLAUDE.md §6.6 calls out (StarField hit the identical issue).
 */
type ClockRegistry = {
  subscribers: Set<() => void>;
  intervalId: ReturnType<typeof setInterval> | null;
  currentMinute: number;
};

const g = globalThis as unknown as { __nexusMinuteClock?: ClockRegistry };
const reg: ClockRegistry =
  g.__nexusMinuteClock ??
  (g.__nexusMinuteClock = { subscribers: new Set(), intervalId: null, currentMinute: Date.now() });

function ensureInterval(): void {
  if (reg.intervalId != null) return;
  reg.intervalId = setInterval(() => {
    reg.currentMinute = Date.now();
    reg.subscribers.forEach((fn) => fn());
  }, 60_000);
}

function maybeStopInterval(): void {
  if (reg.subscribers.size === 0 && reg.intervalId != null) {
    clearInterval(reg.intervalId);
    reg.intervalId = null;
  }
}

/**
 * Re-renders the calling component once a minute and returns the shared current
 * minute timestamp (ms). All callers tick together and read the same value, so
 * widgets can't disagree near an event boundary.
 */
export function useMinuteClock(): number {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const cb = () => forceTick((n) => n + 1);
    reg.subscribers.add(cb);
    // Refresh the shared snapshot and re-render ALL current subscribers, so a
    // freshly-mounted widget shows the current minute on its next paint —
    // instead of the stale value left from before the interval last stopped,
    // which would otherwise persist until the next 60s tick. Peers re-sync too.
    reg.currentMinute = Date.now();
    reg.subscribers.forEach((fn) => fn());
    ensureInterval();
    return () => {
      reg.subscribers.delete(cb);
      maybeStopInterval();
    };
  }, []);
  return reg.currentMinute;
}
