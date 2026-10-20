// NEX-312 (roadmap 1.3): the pure model behind the listening waveform.
//
// The original ask was Wispr Flow's quality: "instead of the voice, when you're
// talking to the command center, it types out what you're speaking... I wanted
// it to show you an audio of your voice going up and down."
//
// Live transcription already works. What is missing is the CONTINUOUS PROOF
// that you are being heard. Today the Command overlay says "I'm listening." in
// words and the orb does a discrete per-state scale bump. Words are a claim;
// a trace that moves with your voice is evidence.
//
// ─── The design decision (owner directive) ───────────────────────────────────
//
// The waveform REPLACES the words, it does not sit above them. While listening,
// the poetic "I'm listening." line gives up its slot to the trace. Two reasons
// beyond the directive itself:
//
//   1. A line that says "I'm listening" next to a trace that SHOWS listening is
//      redundant, and §1.5 Law D treats the fold as a working-memory contract.
//      Two elements making one claim is one too many.
//   2. Anything that only ever says the same sentence is chrome. The trace
//      carries strictly more information in the same space.
//
// The tracked-caps instruction ("TAP WHEN DONE") is NOT replaced — that is a
// different job (how to stop), not a restatement of state. And the orb keeps
// its `accessibilityLabel="Listening"`, so the state remains announced to
// VoiceOver even though the visual carrier is now decorative (§1.5 UF-01: the
// accessibility floor is gating, and a decorative visual may never be the only
// carrier of a state).
//
// ─── Why this file is pure ───────────────────────────────────────────────────
//
// The amplitude SOURCE is the risky part: it needs an `Audio.Recording` metering
// tap running alongside the recognizer, which is a device-only question (see the
// spike note in the roadmap — the retired dual-path proves it worked once, but
// `use-live-transcription.ts` documents an audio-mode patch that got the process
// SIGTERM'd). None of that risk belongs in the geometry. Everything here is a
// pure function of numbers, so the shape is settled and covered by the Node
// vitest suite before any microphone is involved.

/** Bars drawn in the trace. Small: this is a breath, not a hero (§1.4). */
export const BAR_COUNT = 24;

/**
 * dBFS range mapped to 0..1.
 *
 * `expo-av` metering reports decibels relative to full scale: 0 is clipping,
 * negative is quieter, and silence floors around -160. Mapping the full range
 * would leave normal speech in a narrow band near the top and make the trace
 * look dead. -60 is roughly "quiet room", so it is treated as zero.
 */
export const MIN_DB = -60;
export const MAX_DB = 0;

/**
 * Resting bar height (0..1) when there is no signal.
 *
 * Deliberately non-zero. A flat line reads as "broken" or "not listening",
 * which is the exact anxiety this feature exists to remove. A low idle line
 * reads as "open and hearing nothing yet."
 */
export const IDLE_LEVEL = 0.08;

/**
 * Smoothing factor for the level follower, per sample.
 *
 * Raw metering is jumpy enough to read as flicker rather than voice. This is an
 * asymmetric follower: fast attack so a syllable lands immediately (latency
 * here is felt as "it didn't hear me"), slower release so the trace decays like
 * a real level meter rather than snapping to idle between words.
 */
export const ATTACK = 0.6;
export const RELEASE = 0.15;

/** Clamp helper — every public function returns values inside 0..1. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Metering decibels -> normalized 0..1 level.
 *
 * Tolerates the shapes a real device actually produces: `undefined` before the
 * first sample, `-Infinity` on true digital silence, and occasional positive
 * values on clipping.
 */
export function normalizeDb(db: unknown): number {
  if (typeof db !== 'number' || Number.isNaN(db)) return 0;
  if (db === -Infinity) return 0;
  if (db >= MAX_DB) return 1;
  if (db <= MIN_DB) return 0;
  return clamp01((db - MIN_DB) / (MAX_DB - MIN_DB));
}

/**
 * One step of the asymmetric level follower.
 *
 * @param prev  previous smoothed level (0..1)
 * @param next  freshly normalized level (0..1)
 */
export function followLevel(prev: number, next: number): number {
  const p = clamp01(prev);
  const n = clamp01(next);
  const k = n > p ? ATTACK : RELEASE;
  return clamp01(p + (n - p) * k);
}

/**
 * Push a level into the rolling history, newest LAST.
 *
 * Returns a new array capped at `size`. The trace scrolls: the oldest sample
 * falls off the left as a new one arrives on the right, which is what makes it
 * read as time passing rather than as a bar chart.
 */
export function pushLevel(history: readonly number[], level: number, size: number = BAR_COUNT): number[] {
  const safe = Array.isArray(history) ? history : [];
  const next = [...safe, clamp01(level)];
  return next.length > size ? next.slice(next.length - size) : next;
}

/** A history buffer of exactly `size` entries, all at rest. */
export function idleHistory(size: number = BAR_COUNT): number[] {
  return new Array(Math.max(0, Math.floor(size))).fill(IDLE_LEVEL);
}

/**
 * Turn the level history into drawable bar heights (0..1), oldest first.
 *
 * Two shaping passes, both for legibility rather than fidelity:
 *
 *  - **Floor at IDLE_LEVEL**, so the trace never collapses to an invisible line
 *    during a pause between words.
 *  - **Taper the edges**, so the trace fades in and out at its ends instead of
 *    terminating in two hard vertical strokes. This is what keeps it reading as
 *    a breath rather than as a chart.
 */
export function barHeights(history: readonly number[], size: number = BAR_COUNT): number[] {
  const safe = Array.isArray(history) ? history : [];
  // Left-pad with idle so a just-started capture draws a full-width trace
  // rather than growing in from the left, which reads as a loading bar.
  const padded =
    safe.length >= size
      ? safe.slice(safe.length - size)
      : [...new Array(size - safe.length).fill(IDLE_LEVEL), ...safe];

  return padded.map((v, i) => {
    const level = Math.max(IDLE_LEVEL, clamp01(v));
    // Symmetric taper: 1 at the centre, ~0.55 at the outermost bar.
    const t = size <= 1 ? 1 : i / (size - 1);
    const taper = 0.55 + 0.45 * Math.sin(Math.PI * t);
    return clamp01(level * taper);
  });
}

/**
 * Should the waveform be shown at all?
 *
 * The waveform REPLACES the "I'm listening." line, so this is the predicate
 * that decides which of the two the overlay renders. It returns false whenever
 * the amplitude source is unavailable — permission denied, the metering tap
 * failed to start, or Reduce Motion is on — and the caller falls back to the
 * words.
 *
 * That fallback is the whole safety story for this feature: replacing text with
 * a visual is only acceptable if the text returns the moment the visual cannot
 * be honest. A frozen or absent trace would be a worse lie than the sentence it
 * replaced.
 */
export function shouldShowWaveform(opts: {
  listening: boolean;
  meteringAvailable: boolean;
  reduceMotion: boolean;
}): boolean {
  return !!opts && opts.listening === true && opts.meteringAvailable === true && opts.reduceMotion !== true;
}
