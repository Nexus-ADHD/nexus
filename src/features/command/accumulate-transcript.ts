/**
 * accumulateTranscript — fold a freshly-emitted speech-recognition segment
 * into the running session transcript.
 *
 * Why this exists (NEX-149): in continuous mode iOS does NOT hand us one
 * ever-growing cumulative transcript. After a long pause it ends the current
 * SFSpeechRecognitionTask and starts a fresh one whose `results[0].transcript`
 * begins empty — so each `isFinal` is a NEW segment that must be appended (per
 * expo-speech-recognition's continuous-mode contract). The hook previously
 * REPLACED with the latest segment, which dropped everything spoken before the
 * pause on the Weekly Debrief and the Command orb.
 *
 * Defensive against the opposite failure (NEX-80 doubling): if a build or OS
 * version ever DOES hand us a cumulative transcript, `segment` already contains
 * everything we've committed, so we replace rather than concatenate. That guard
 * is WORD-BOUNDED (`committed + ' '`) so a genuinely new segment that merely
 * shares a string prefix — e.g. committed `go`, segment `going to the store` —
 * is appended, not silently dropped (Greptile NEX-149 review). An exact
 * whole-buffer re-delivery (`next === committed`) is treated as a duplicate and
 * ignored.
 *
 * We intentionally do NOT dedupe by suffix: a trailing word that repeats earlier
 * speech (committed `I said yes`, segment `yes`) is real dictated content and
 * must be kept (`I said yes yes`), not collapsed (Codex review). The only
 * ambiguous case left — the entire transcript so far is one phrase and the user
 * repeats exactly that phrase — is indistinguishable from a recognizer re-fire
 * and is collapsed; acceptable given how marginal it is on these
 * paragraph/command surfaces.
 *
 * Pure + dependency-free so it can be unit-tested without the native module.
 */
export function accumulateTranscript(committed: string, segment: string): string {
  const next = (segment ?? '').trim();
  if (!next) return committed;
  if (!committed) return next;
  // Cumulative transcript handed to us whole — replace, don't double. Word-
  // bounded so a new segment that only shares a string prefix is still appended.
  if (next === committed || next.startsWith(`${committed} `)) return next;
  return `${committed} ${next}`;
}
