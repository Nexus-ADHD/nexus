/**
 * The image and its geometry travel together, or not at all.
 *
 * Greptile T-Rex found on PR #439 that the stale-image fallback kept pixels
 * from the previously painted frame while the mesh went on using the NEW
 * frame's rotation, clip and wave band — it reproduced frame 0's art rendered
 * at frame 4's -14deg rotation, 219deg clip and [14, 233] band, against frame
 * 0's own 0, 82 and [0, 82].
 *
 * This is `lastPair` all over again, one layer down. The rewrite deleted that
 * cache on the grounds that "with one image there is no pairing to get wrong,"
 * and then paired an image with a pose read live beside it.
 */
import { describe, expect, it } from 'vitest';

import { coherentPaint, type PaintGeometry } from '../ouroboros-frames';

const FRAME0: PaintGeometry = { frame: 0, rotationDeg: 0, arcDeg: 82 };
const FRAME4: PaintGeometry = { frame: 4, rotationDeg: -14, arcDeg: 219 };

describe('coherentPaint', () => {
  it('uses the wanted geometry when the wanted frame is decoded', () => {
    expect(coherentPaint('f4', FRAME4, { ...FRAME0, image: 'f0' })).toEqual({
      ...FRAME4,
      image: 'f4',
      stale: false,
    });
  });

  it('draws nothing at all when nothing has ever been painted', () => {
    expect(coherentPaint(null, FRAME4, null)).toBeNull();
  });

  it('holds the CACHED geometry when the cached frame is a different one', () => {
    // The finding, as an assertion. Frame 0's pixels may never be drawn at
    // frame 4's rotation, clip or band.
    const got = coherentPaint(null, FRAME4, { ...FRAME0, image: 'f0' });
    expect(got).toEqual({ ...FRAME0, image: 'f0', stale: true });
    expect(got?.rotationDeg).not.toBe(FRAME4.rotationDeg);
    expect(got?.arcDeg).not.toBe(FRAME4.arcDeg);
  });

  it('takes the LIVE pose when the cached image is the same frame', () => {
    // The half a naive fix gets wrong. Rotation moves every rAF while the frame
    // index changes a handful of times in a whole count-up, so freezing the
    // pose on every pending decode would stall the animal's growth — the exact
    // crawl-then-lurch NEX-339 was opened to remove.
    const wantLater: PaintGeometry = { frame: 0, rotationDeg: -3.5, arcDeg: 78.5 };
    expect(coherentPaint(null, wantLater, { ...FRAME0, image: 'f0' })).toEqual({
      ...wantLater,
      image: 'f0',
      stale: false,
    });
  });

  it('never returns a mix of two frames, over every cached/wanted pairing', () => {
    // The invariant behind all of the above, stated once over the whole space:
    // whatever comes back, its three geometry fields agree with exactly one
    // frame — the one whose image it carries.
    const frames: PaintGeometry[] = [
      FRAME0,
      FRAME4,
      { frame: 9, rotationDeg: -4, arcDeg: 356 },
    ];
    for (const want of frames) {
      for (const cached of frames) {
        const got = coherentPaint(null, want, { ...cached, image: `img${cached.frame}` });
        expect(got).not.toBeNull();
        const source = got!.image === `img${cached.frame}` ? cached : null;
        expect(source).not.toBeNull();
        // Geometry belongs to the frame the pixels came from, unless the pixels
        // already ARE the wanted frame (then the live pose is correct).
        const expected = cached.frame === want.frame ? want : cached;
        expect({
          frame: got!.frame,
          rotationDeg: got!.rotationDeg,
          arcDeg: got!.arcDeg,
        }).toEqual(expected);
      }
    }
  });

  it('marks staleness only on a frame change, so the caller can suppress the blend', () => {
    expect(coherentPaint(null, FRAME4, { ...FRAME0, image: 'f0' })?.stale).toBe(true);
    expect(coherentPaint(null, FRAME0, { ...FRAME0, image: 'f0' })?.stale).toBe(false);
    expect(coherentPaint('f4', FRAME4, { ...FRAME0, image: 'f0' })?.stale).toBe(false);
  });
});
