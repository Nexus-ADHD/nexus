#!/usr/bin/env node
/**
 * Backdrop resolution guard.
 *
 * The shipped cosmic backdrop was 941x1672 and rendered on a Pro-sized phone at
 * ~1.53x upscale — about 65% of native panel resolution. Every star inside it
 * was a soft, JPEG-mushed blob sitting under 80 crisp full-resolution vector
 * stars: two optical worlds stacked, which the eye reads as "UI drawn on a
 * picture" rather than as one sky.
 *
 * No design review caught it, because both layers look fine on their own. This
 * is the check that would have.
 *
 * Runs in CI as a step on the existing `lint` job (the NEX-115 pattern — a new
 * required check stalls every in-flight PR; a step on an already-required job
 * enforces the moment it merges).
 */

import { readFileSync, existsSync } from 'node:fs';

// @3x for the largest phone (iPhone Pro Max, 430x932pt). Mirrors
// MIN_BACKDROP_WIDTH/HEIGHT in src/components/ui/starfield-optics.ts.
const MIN_W = 1290;
const MIN_H = 2796;

/** Full-screen backdrop assets. Anything here must clear native resolution. */
const BACKDROPS = ['assets/images/cosmic-field-bg.png'];

/** PNG: dimensions live in the IHDR chunk at a fixed offset. */
function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** JPEG: walk the segment markers to the SOFn frame header. */
function jpegSize(buf) {
  if (buf.readUInt16BE(0) !== 0xffd8) return null;
  let off = 2;
  while (off < buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    const len = buf.readUInt16BE(off + 2);
    // SOF0-SOF15, excluding the non-frame markers DHT/JPG/DAC
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}

function measure(path) {
  const buf = readFileSync(path);
  return pngSize(buf) ?? jpegSize(buf);
}

let failed = false;
for (const path of BACKDROPS) {
  if (!existsSync(path)) {
    console.error(`✗ ${path} — missing`);
    failed = true;
    continue;
  }
  const size = measure(path);
  if (!size) {
    console.error(`✗ ${path} — could not read dimensions (unsupported format?)`);
    failed = true;
    continue;
  }
  const { width, height } = size;
  if (width < MIN_W || height < MIN_H) {
    const upscale = Math.max(MIN_W / width, MIN_H / height);
    console.error(
      `✗ ${path} — ${width}x${height} is below the @3x floor ${MIN_W}x${MIN_H}. ` +
        `It would render at ${upscale.toFixed(2)}x upscale ` +
        `(${Math.round((1 / upscale) * 100)}% of native).`,
    );
    failed = true;
  } else {
    console.log(`✓ ${path} — ${width}x${height}`);
  }
}

if (failed) {
  console.error('\nBackdrop assets must be authored at or above native panel resolution.');
  console.error('Regenerate with:  python3 scripts/bake-starfield.py');
  process.exit(1);
}
console.log('Backdrop resolution OK.');
