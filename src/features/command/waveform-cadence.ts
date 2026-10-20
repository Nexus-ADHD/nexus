// NEX-316 (roadmap 1.3, safe slice): the cadence driver for the listening
// waveform.
//
// The honest amplitude source — an `Audio.Recording` metering tap running
// alongside the recognizer — is a device-only question with a real
// audio-session SIGTERM risk (see the spike note in waveform-model.ts). This
// slice ships the VISIBLE waveform now, driven not by microphone loudness but
// by the recognizer's own cadence: the trace rises as your transcript grows and
// breathes gently while you pause. It is less literally faithful than a dBFS
// meter, but it moves with your speech, carries zero audio-session risk, and
// never touches the recognizer that voice capture depends on.
//
// Everything here is a pure function of numbers, so the shape is settled and
// covered by the Node vitest suite before it drives any view. The React/
// Reanimated glue (the ticker + the shared value + the bars) lives in the
// RN-coupled CommandWaveform.tsx, which cannot be imported by the pure suite.

import { IDLE_LEVEL, followLevel } from './waveform-model';

/**
 * Ticker interval, ms. ~70ms (≈14fps) is enough for a scrolling trace that
 * reads as continuous motion — the waveform is a breath, not a hero (§1.4), so
 * it does not need 60fps, and a slower tick keeps the JS→UI writes cheap.
 */
export const TICK_MS = 70;

/** Clamp helper — mirrors the model's, kept local so this module stays pure. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Map transcript GROWTH (characters gained since the last tick) to a target
 * level (0..1).
 *
 * Only positive growth drives the trace up: when the recognizer flips interim
 * text to a shorter cleaned final, the combined length can drop, and a "you
 * spoke" spike on a shrink would be a lie. Non-positive growth returns 0 so the
 * level decays toward the idle breath instead.
 *
 * The mapping is deliberately gentle at the bottom (a single stray character
 * must not peg the bars) and saturates by roughly a spoken word (~5–6 chars per
 * 70ms is fast speech), so normal talking lands in the expressive middle.
 */
export function levelFromGrowth(growthChars: number): number {
  if (!Number.isFinite(growthChars) || growthChars <= 0) return 0;
  return clamp01(0.28 + growthChars * 0.09);
}

/**
 * The resting motion when no words are arriving.
 *
 * A flat trace during a pause reads as "frozen / did it hear me?" — the exact
 * anxiety this feature exists to remove. So even in silence the level gently
 * undulates just above idle. Period is ~0.9s at TICK_MS (sin arg 0.5/tick), a
 * slow breath rather than a pulse.
 */
export function idleBreath(tick: number): number {
  const t = Number.isFinite(tick) ? tick : 0;
  const s = 0.5 + 0.5 * Math.sin(t * 0.5);
  return clamp01(IDLE_LEVEL + 0.06 * s);
}

/**
 * Magnitude of change in the transcript-length accumulator.
 *
 * The cadence source is the recognizer's full transcript-so-far. What we want
 * the trace to reflect is "words are being recognized right now" — ANY activity,
 * whether the transcript grows (new speech) or is revised shorter (the
 * recognizer corrects an interim hypothesis, which is still active speech). So
 * cadence is driven by the ABSOLUTE change per tick, not signed growth:
 *
 *  - a monotonic-max/positive-only delta suppressed cadence after a revision —
 *    once the length dipped below an earlier peak, continued speech below that
 *    peak read as zero growth and the trace went flat mid-sentence.
 *  - absolute change pulses on growth AND revision, and settles to 0 only when
 *    the transcript is stable (a real pause), which is exactly the intent.
 *
 * (The old double-count spike this guarded against is gone at the source: the
 * caller feeds the single accumulated transcript, not final+interim.)
 */
export function changeMagnitude(prevLen: number, curLen: number): { delta: number; nextLen: number } {
  const p = Number.isFinite(prevLen) && prevLen > 0 ? prevLen : 0;
  const c = Number.isFinite(curLen) && curLen > 0 ? curLen : 0;
  return { delta: Math.abs(c - p), nextLen: c };
}

/**
 * One step of the cadence follower: take the previous smoothed level, the
 * growth since last tick, and the tick counter, and return the next level.
 *
 * The target is the LOUDER of "you are speaking" (growth) and "you are heard,
 * silently" (the idle breath), then run through the model's asymmetric follower
 * so a word lands fast and a pause decays like a real level meter.
 */
export function nextWaveLevel(prevLevel: number, growthChars: number, tick: number): number {
  const target = Math.max(levelFromGrowth(growthChars), idleBreath(tick));
  return followLevel(prevLevel, target);
}
