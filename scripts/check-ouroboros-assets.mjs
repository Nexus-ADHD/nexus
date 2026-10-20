#!/usr/bin/env node
/**
 * Guard the authored ouroboros frame set.
 *
 * Rides the already-required `lint` job rather than adding a required check of
 * its own (NEX-115 pattern: a new required check stalls every in-flight PR).
 *
 * Rewritten for NEX-338. It used to guard four baked PNGs — a strip, two jaw
 * sheets and the bite — and cross-check them against a profile.json full of
 * mesh tables. All of that is gone with the rig; the hero is now one authored
 * WebP per score step. So the shape of the guard changes with it:
 *
 *   - dimensions come out of the WebP VP8X/VP8L/VP8 header, not the PNG IHDR
 *   - the important budget is now the TOTAL, not per-file. Twenty frames at a
 *     comfortable individual size is still a bundle problem, and the per-file
 *     limit would never notice.
 *   - the frame table has to agree with `ouroboros-frames.ts`, because a
 *     missing frame is an index into `undefined` at runtime, not a wobble.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGEN = 'Regenerate with: python3 scripts/ouroboros/frames.py provisional';
const DIR = 'assets/images/ouroboros-frames';

/** Mirrors ouroboros-frames.ts. Asserted against it below rather than trusted. */
const FRAME_STEP = 10;
const FIRST_FRAME_SCORE = 20;
/**
 * EXPLICIT, not derived from FRAME_STEP. Score 95 is off the 10-point grid --
 * the tenth frame sits between 90 and 100 to narrow the step into the finale,
 * so the arithmetic that used to generate this list no longer describes it.
 */
const SCORES = [20, 30, 40, 50, 60, 70, 80, 90, 95, 100];

/** Minimums, not exact sizes: the art may legitimately get sharper, never blurrier. */
const FULL_MIN = 1024;
const PROXY_MIN = 384;

/**
 * Total shipped weight, in KB.
 *
 * This is the number that actually matters and the one the old per-file guard
 * could not see. It is also two numbers in practice — these bytes ride the app
 * binary AND every EAS Update payload — so keep it deliberately tight.
 */
const TOTAL_MAX_KB = 12 * 1024;

/**
 * WebP dimensions, dependency-free, mirroring how pngSize worked before.
 *
 * RIFF container: bytes 0-3 'RIFF', 8-11 'WEBP', then a chunk header at 12.
 * Three encodings in the wild and the frame set can legitimately contain more
 * than one, since an alpha frame is VP8X while a flat one may not be.
 */
function webpSize(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    // 24-bit little-endian, stored as (dimension - 1)
    return {
      width: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (buf.readUIntLE(27, 3) & 0xffffff) + 1,
    };
  }
  if (fourcc === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

const problems = [];
let totalBytes = 0;

for (const score of SCORES) {
  const tag = String(score).padStart(3, '0');
  // Four files per score: the whole serpent at both resolutions, and the
  // head-and-neck cut of it at both. The hero draws one of each -- a clipped
  // body under a rotated head -- so a missing head is a headless serpent, not
  // a wobble.
  for (const [kind, min] of [
    ['frame', FULL_MIN],
    ['proxy', PROXY_MIN],
    ['head', FULL_MIN],
    ['headproxy', PROXY_MIN],
  ]) {
    const rel = `${DIR}/${kind}-${tag}.webp`;
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) {
      problems.push(`${rel} is missing. ${REGEN}`);
      continue;
    }
    const size = webpSize(readFileSync(abs));
    if (!size) {
      problems.push(`${rel} is not a readable WebP.`);
      continue;
    }
    if (size.width < min || size.height < min) {
      problems.push(
        `${rel} is ${size.width}x${size.height}, below the ${min}x${min} floor. ${REGEN}`,
      );
    }
    if (size.width !== size.height) {
      // The hero draws into a square box with fit="contain"; a non-square frame
      // would be letterboxed, which silently shrinks the serpent off its circle.
      problems.push(`${rel} is ${size.width}x${size.height}, not square.`);
    }
    totalBytes += statSync(abs).size;
  }
}

const totalKB = Math.round(totalBytes / 1024);
if (totalKB > TOTAL_MAX_KB) {
  problems.push(
    `the frame set is ${totalKB}KB, over the ${TOTAL_MAX_KB}KB budget. ` +
      `These bytes ride the app binary AND every OTA update payload. ` +
      `Lower the WebP quality in frames.py before cutting frames.`,
  );
}

/**
 * The generated manifest and the hand-written model must agree.
 *
 * They are written by different things — frames.py emits the require() list,
 * a human maintains the score model — so nothing but a check keeps them in
 * step, and a disagreement is an out-of-range index at runtime.
 */
const manifest = resolve(ROOT, 'src/components/ui/ouroboros-frame-sources.ts');
const model = resolve(ROOT, 'src/components/ui/ouroboros-frames.ts');
if (!existsSync(manifest)) {
  problems.push(`src/components/ui/ouroboros-frame-sources.ts is missing. ${REGEN}`);
} else {
  const src = readFileSync(manifest, 'utf8');
  // All four arrays, not just the frames. A manifest missing a head entry gives
  // `headProxies[8] === undefined`, which the component turns into a null head —
  // a serpent with a visible stump where its head should be, and a green build.
  for (const [name, kind] of [
    ['OUROBOROS_FRAME_FULL', 'frame'],
    ['OUROBOROS_FRAME_PROXY', 'proxy'],
    ['OUROBOROS_HEAD_FULL', 'head'],
    ['OUROBOROS_HEAD_PROXY', 'headproxy'],
  ]) {
    const block = src.split(`${name} = [`)[1]?.split(']')[0] ?? '';
    const n = (block.match(/require\(/g) ?? []).length;
    if (n !== SCORES.length) {
      problems.push(`${name} lists ${n} frames, expected ${SCORES.length}. ${REGEN}`);
    }
    for (const score of SCORES) {
      const tag = String(score).padStart(3, '0');
      if (!block.includes(`${kind}-${tag}.webp`)) {
        problems.push(`${name} does not reference ${kind}-${tag}.webp. ${REGEN}`);
      }
    }
  }
}

if (existsSync(model)) {
  const src = readFileSync(model, 'utf8');
  const step = Number(src.match(/FRAME_STEP\s*=\s*(\d+)/)?.[1]);
  if (step !== FRAME_STEP) {
    problems.push(
      `ouroboros-frames.ts has FRAME_STEP=${step} but this guard assumes ${FRAME_STEP}. ` +
        `Update both, then regenerate the frames.`,
    );
  }
  // RING_FRAC is stated on both sides of the pipeline -- python registers the
  // art to it, TypeScript documents it -- so drift means the shipped frames sit
  // on a different circle from the one the code claims.
  const tsFrac = src.match(/RING_FRAC\s*=\s*([\d.]+)/)?.[1];
  const py = resolve(ROOT, 'scripts/ouroboros/frames.py');
  if (existsSync(py)) {
    const pySrc = readFileSync(py, 'utf8');
    const pyFrac = pySrc.match(/^RING_FRAC\s*=\s*([\d.]+)/m)?.[1];
    // A pattern that stops matching must FAIL, not quietly pass. These regexes
    // are the only thing holding the two sides of the pipeline together, and a
    // routine edit (indenting a constant, dropping `Object.freeze`) is enough to
    // break one — at which point a silent skip retires the guard without saying so.
    if (!tsFrac) problems.push('could not read RING_FRAC from ouroboros-frames.ts.');
    if (!pyFrac) problems.push('could not read RING_FRAC from frames.py.');
    if (tsFrac && pyFrac && tsFrac !== pyFrac) {
      problems.push(
        `RING_FRAC disagrees: ouroboros-frames.ts says ${tsFrac}, frames.py says ${pyFrac}. ` +
          `The frames are registered to the python value.`,
      );
    }

    // Same contract for the head angles, and a sharper one: these drive where
    // the head sprite is ROTATED TO, so a stale entry does not merely mislabel
    // the art, it dislocates the neck. `frames.py audit` re-derives them.
    // Anchored on `Object.freeze([` rather than the first `[` after the name --
    // the declaration's own `readonly number[]` is an empty pair of brackets and
    // a looser pattern captures that instead, which reads as "1 entry" and
    // passes nothing useful.
    const tsHeads = src
      .match(/FRAME_HEAD_DEG[\s\S]*?Object\.freeze\(\[([^\]]+)\]/)?.[1]
      ?.split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    const pyHeads = pySrc
      .match(/^HEAD_DEG\s*=\s*\{([\s\S]*?)\}/m)?.[1]
      ?.split(',')
      .map((pair) => pair.split(':')[1]?.trim())
      .filter(Boolean);
    if (!tsHeads) problems.push('could not read FRAME_HEAD_DEG from ouroboros-frames.ts.');
    if (!pyHeads) problems.push('could not read HEAD_DEG from frames.py.');
    if (tsHeads && pyHeads) {
      if (tsHeads.length !== SCORES.length) {
        problems.push(
          `FRAME_HEAD_DEG has ${tsHeads.length} entries for ${SCORES.length} frames.`,
        );
      } else if (
        tsHeads.map(Number).join(',') !== pyHeads.map(Number).join(',')
      ) {
        problems.push(
          `FRAME_HEAD_DEG disagrees: ouroboros-frames.ts says [${tsHeads.join(', ')}], ` +
            `frames.py says [${pyHeads.join(', ')}]. Re-run \`frames.py audit\`; ` +
            `the art is the authority.`,
        );
      }
    }

    // The seam is described from two sides -- the head sprite's feather is cut
    // in python, the body's clip is computed in TypeScript -- so these two must
    // agree or the neck opens with no other signal.
    for (const name of ['NECK_DEG', 'NECK_FEATHER_DEG']) {
      const ts = src.match(new RegExp(`${name}\\s*=\\s*([\\d.]+)`))?.[1];
      const py = pySrc.match(new RegExp(`^${name}\\s*=\\s*([\\d.]+)`, 'm'))?.[1];
      if (!ts || !py) {
        problems.push(`could not read ${name} from both sides.`);
      } else if (Number(ts) !== Number(py)) {
        problems.push(
          `${name} disagrees: ouroboros-frames.ts says ${ts}, frames.py says ${py}. ` +
            `The head sprite is cut to the python value and the body is clipped to the TS one.`,
        );
      }
    }
  }
}

if (problems.length) {
  console.error('Ouroboros hero assets:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(
  `Ouroboros hero assets ok (${SCORES.length} frames + heads, both resolutions, ${totalKB}KB).`,
);
