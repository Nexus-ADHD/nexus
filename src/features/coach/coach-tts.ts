/**
 * coach-tts.ts — the coach's spoken reply through the proxy's /tts route
 * (ElevenLabs, with OpenAI gpt-4o-mini-tts as the fallback; the provider is
 * the proxy's decision, see ai-proxy /tts), buffered to a cache file for
 * expo-av.
 *
 * Kept apart from ai-client so ai-client stays Node-testable: this module
 * imports expo/fetch (a real byte body) and expo-file-system. The decisions
 * that need no I/O are exported pure so vitest covers them.
 */

import { fetch as expoFetch } from 'expo/fetch';
import { File, Paths } from 'expo-file-system';
import { aiProxyRequest } from '../../utils/ai-client';

/** The proxy rejects longer input (OpenAI's cap); the fallback voice reads it instead. */
export const TTS_MAX_CHARS = 4096;
/** Whole clip must land inside this; a 20s reply renders in ~3s. */
export const TTS_TIMEOUT_MS = 15000;

/** Pure: whether a reply is worth a network round trip for speech. */
export function ttsEligible(text: string): boolean {
  const t = (text ?? '').trim();
  return t.length > 0 && t.length <= TTS_MAX_CHARS;
}

/** Pure: a cache file name that cannot collide across quick turns. */
export function ttsFileName(now: number, seq: number): string {
  return `coach-tts-${now}-${seq}.mp3`;
}

let seq = 0;

export interface SynthesizedSpeech {
  /** file:// URI of the MP3 clip. */
  uri: string;
  /** Wall time of the whole request. */
  ms: number;
  /** Validated server attribution; older proxies may omit the header. */
  provider: 'elevenlabs' | 'openai' | 'unknown';
}

/**
 * Fetch the clip for `text`. Throws on any failure (the caller falls back to
 * the system voice); never returns a partial file.
 */
export async function synthesizeSpeech(text: string, signal?: AbortSignal): Promise<SynthesizedSpeech> {
  const startedAt = Date.now();
  if (!ttsEligible(text)) throw new Error('tts: text not eligible');
  const { url, headers } = await aiProxyRequest('tts');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort);
  try {
    const res = await expoFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: text.trim() }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 120);
      throw new Error(`tts: ${res.status} ${detail}`);
    }
    const bytes = await res.bytes();
    if (bytes.byteLength < 64) throw new Error('tts: empty clip');
    seq += 1;
    const file = new File(Paths.cache, ttsFileName(startedAt, seq));
    file.write(bytes);
    const header = res.headers.get('X-Tts-Provider');
    const provider = header === 'elevenlabs' || header === 'openai' ? header : 'unknown';
    return { uri: file.uri, ms: Date.now() - startedAt, provider };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Best effort: drop a clip once it has been played. */
export function discardSpeechFile(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // The cache directory is the OS's to reclaim.
  }
}
