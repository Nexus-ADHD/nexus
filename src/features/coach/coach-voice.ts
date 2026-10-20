/**
 * coach-voice.ts — which system voice the coach speaks with, as pure functions.
 *
 * expo-speech reads with whatever `AVSpeechSynthesisVoice` iOS picks for the
 * language, which is the compact "Default" quality voice on most phones: the
 * flat, clipped one. Every recent iPhone also carries at least one "Enhanced"
 * (and on iOS 17+, "Premium") voice for the person's language, downloaded
 * with the OS. Same API, same cost, and it is the difference between a
 * mentor and a satnav. This module picks it; the screen only reads the list.
 * The SDK's `quality` field never says "Premium" (see qualityRank), so the
 * identifier is read too.
 *
 * RN-free so vitest covers the ranking.
 */

/** The subset of expo-speech's `Voice` this module reads. */
export interface CoachVoiceCandidate {
  identifier: string;
  name: string;
  /** 'Default' | 'Enhanced' | 'Premium' on iOS; free text elsewhere. */
  quality?: string;
  /** BCP 47, e.g. 'en-US'. */
  language: string;
}

/** Slightly under 1.0: the reply is a mentor talking, not a screen reader. */
export const COACH_SPEECH_RATE = 0.96;

// Novelty / effect voices Apple ships alongside the real ones. Never these.
const NOVELTY_RE = /\b(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Wobble|Eddy|Flo|Fred|Good News|Grandma|Grandpa|Jester|Junior|Kathy|Organ|Ralph|Reed|Rocko|Sandy|Shelley|Superstar|Trinoids|Whisper|Zarvox)\b/i;

/**
 * expo-speech 14 maps AVSpeechSynthesisVoiceQuality to 'Enhanced' or
 * 'Default' only, so a Premium voice arrives as 'Default' (SpeechModule.swift).
 * Apple encodes the tier in the identifier as well
 * (`com.apple.voice.premium.en-US.Zoe`, `...enhanced...`, `...compact...`;
 * Siri voices end `_premium` / `_enhanced`), so the identifier decides when
 * the quality field cannot.
 */
function qualityRank(quality: string | undefined, identifier: string): number {
  const q = (quality ?? '').toLowerCase();
  const id = identifier.toLowerCase();
  if (q === 'premium' || /\.premium\.|_premium\b/.test(id)) return 3;
  if (q === 'enhanced' || /\.enhanced\.|_enhanced\b/.test(id)) return 2;
  return 0;
}

function languageRank(language: string, preferred: string): number {
  const l = language.toLowerCase();
  const p = preferred.toLowerCase();
  if (l === p) return 3;
  const base = p.split('-')[0];
  if (l.split('-')[0] === base) return l === `${base}-us` ? 2 : 1;
  return -1;
}

/**
 * The best voice for the coach, or null to let the OS choose. Only the
 * person's language is considered; within it quality wins (Premium >
 * Enhanced > Default) and the locale breaks ties (exact, then en-US, then
 * any other region): an Enhanced voice in a neighbouring accent reads
 * better than the compact voice in the person's own. Never a novelty voice.
 * Remaining ties break on name so the pick is stable across launches.
 */
export function pickCoachVoice(voices: readonly CoachVoiceCandidate[], preferredLocale = 'en-US'): string | null {
  let best: CoachVoiceCandidate | null = null;
  let bestScore = -Infinity;
  for (const v of voices) {
    if (!v || typeof v.identifier !== 'string' || !v.identifier) continue;
    if (NOVELTY_RE.test(v.name ?? '')) continue;
    const lang = languageRank(v.language ?? '', preferredLocale);
    if (lang < 0) continue;
    const score = qualityRank(v.quality, v.identifier) * 10 + lang;
    if (score > bestScore || (score === bestScore && best && (v.name ?? '') < (best.name ?? ''))) {
      best = v;
      bestScore = score;
    }
  }
  // A Default-quality voice is what the OS would pick anyway; returning it
  // adds nothing and pins a name the OS might later replace with a better one.
  if (!best || qualityRank(best.quality, best.identifier) === 0) return null;
  return best.identifier;
}
