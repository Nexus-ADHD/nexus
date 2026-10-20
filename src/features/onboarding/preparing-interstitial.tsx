// NEX-26 phase C — Preparing interstitial.
//
// Shown after the reflection step submits and before the review screen
// renders, while the Pulse call is in flight.
//
// The parent is responsible for dismissing this surface when its data
// is ready. This component only signals "1.5s minimum display has
// elapsed" via `onMinimumElapsed` so the parent can dismiss on the
// later of (data-ready, 1.5s) without a jarring flash for users whose
// Pulse call happens to resolve quickly.
//
// NEX-303: the body is now <NexusSplash/>, the one owner of the loading
// register (wordmark + gold glyph rain). It replaces the wordmark +
// ActivityIndicator this file used to hand-roll, and fills the ~8-15s Pulse
// wait the NEX-57 note below describes. This retires the "cosmic-orb
// interstitial slots in here when the designer's assets land" placeholder that
// headed this file — that note pointed at NEX-24, which is actually ring-tint
// plumbing and closed in May 2026.
//
// This surface renders TRANSPARENT over the global StarField, so the rain
// composites over the galaxy photo + twinkling stars. Both fields freeze
// together under Reduce Motion — they read the same useReduceMotion hook.
//
// Also retired here: a stale note claiming this file's GOLD const was an older
// D4AF37/D4A056 gold pending a NEX-56 migration. It already resolved through
// tokens.color.gold (E5BA6E as of v3 stellar), and its "app/_layout.tsx lines
// ~1444 + 1463" pointer was hundreds of lines stale. Colors now come from
// NexusSplash, which reads the tokens directly.

import React, { useEffect } from 'react';
import { NexusSplash } from '@/src/components/ui/NexusSplash';

interface Props {
  /** Override the default copy. Defaults to the two-line NEX-57 register. */
  label?: string;
  /**
   * Fires exactly once, 1500ms after the component mounts. Parent uses
   * this to defer dismissal until both (a) underlying data is ready
   * AND (b) the minimum display time has passed. The component itself
   * never dismisses or hides.
   */
  onMinimumElapsed?: () => void;
}

const MIN_DISPLAY_MS = 1500;

// NEX-57: generation cost roughly 4x the post-NEX-60 baseline
// (2-3 habits + 2-3 downstream per mandate vs the old 1 habit +
// 1-2 downstream). Real-world wait is ~8-15s. Single-line
// "Preparing your practice…" felt thin for that span. The two-line
// register names the work being done: read first, then name.
const DEFAULT_LABEL = 'Reading your reflection.\nNaming what it asks for.';

export default function PreparingInterstitial({
  label = DEFAULT_LABEL,
  onMinimumElapsed,
}: Props) {
  useEffect(() => {
    if (!onMinimumElapsed) return;
    const t = setTimeout(() => {
      onMinimumElapsed();
    }, MIN_DISPLAY_MS);
    return () => clearTimeout(t);
    // onMinimumElapsed is intentionally captured at mount. If the
    // parent passes a new closure on each render, we still only fire
    // the timer once (per mount), which is the contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <NexusSplash
      label={label}
      background="transparent"
      // Names the work rather than announcing a bare "loading": this wait is
      // long enough that a VoiceOver user deserves to know what it is for. The
      // app-shell gates pass no label, which is why this is per-surface rather
      // than derived from the visible copy. Declarative, no second-person
      // coaching, per §18.
      accessibilityLabel="Preparing your practice. Reading your reflection, and naming what it asks for."
      testID="preparing-interstitial"
    />
  );
}
