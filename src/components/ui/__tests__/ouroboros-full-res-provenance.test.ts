/**
 * Full-resolution pixels must prove which frame produced them.
 *
 * Round two of the same defect on PR #439. Round one gave the LAST-PAINTED
 * cache its geometry; this is the FULL-RES cache, which had the same hole.
 * `useImage` never clears its result when its source changes, so for one render
 * after the settle advances, the state still holds the previous loader's
 * pixels — and the old check compared the NEW frame's index against the live
 * pose, which says "usable" about an image from a different frame entirely.
 *
 * The lesson worth keeping: this component holds three image caches (the proxy
 * set, the full-res frame, the last-painted frame) and each one needed the same
 * discipline. Fixing one and declaring the class closed is what cost the round.
 *
 * (Was pair-keyed while the boundary cross-fade loaded TWO frames; the blend
 * is gone — it ghosted and faded against the filigree art — so the tag is now
 * the frame index itself.)
 */
import { describe, expect, it } from 'vitest';

import { fullResFrameUsable } from '../ouroboros-frames';

describe('fullResFrameUsable', () => {
  it('accepts pixels whose tag matches the settled and wanted frame', () => {
    expect(fullResFrameUsable(4, 4, 4)).toBe(true);
  });

  it('REJECTS pixels left over from the previous frame — the finding', () => {
    // The settle advanced 2 -> 4. The loader has remounted but its effect has
    // not run, so state still holds frame 2's pixels. Under the old index-only
    // check this read as usable and frame 2's art was painted as frame 4.
    expect(fullResFrameUsable(4, 2, 4)).toBe(false);
  });

  it('rejects everything before any loader has reported', () => {
    expect(fullResFrameUsable(4, null, 4)).toBe(false);
    expect(fullResFrameUsable(null, 4, 4)).toBe(false);
  });

  it('still rejects a matching tag the pose has since moved off', () => {
    // Provenance is necessary, not sufficient: the 150ms debounce means the
    // settled frame can be one the live pose no longer wants.
    expect(fullResFrameUsable(4, 4, 6)).toBe(false);
  });

  it('accepts nothing with any disagreement, over the whole frame space', () => {
    // The invariant, stated once: usable exactly when settled, loaded and
    // wanted are all the same frame.
    for (let s = 0; s < 10; s += 1) {
      for (let l = 0; l < 10; l += 1) {
        for (let p = 0; p < 10; p += 1) {
          expect(fullResFrameUsable(s, l, p)).toBe(s === l && l === p);
        }
      }
    }
  });
});
