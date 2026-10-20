/**
 * coach-speaker.ts — one expo-av Sound at a time for the coach's reply.
 *
 * Every trap the plan critique named lives here so the screen cannot forget
 * one: the previous clip is stopped AND unloaded before the next plays, the
 * audio session is put back into playback (a mic session routes to the
 * earpiece), a clip that arrives after stop() is dropped, and the file is
 * deleted after playback.
 */

import { Audio, type AVPlaybackStatus } from 'expo-av';
import { discardSpeechFile } from './coach-tts';

export interface CoachSpeaker {
  /** Play a clip; resolves when playback ends or is stopped. */
  play: (uri: string) => Promise<void>;
  /** Stop and unload whatever is playing (idempotent). */
  stop: () => Promise<void>;
  /** True while a clip is loaded and playing. */
  isSpeaking: () => boolean;
}

export function createCoachSpeaker(): CoachSpeaker {
  let sound: Audio.Sound | null = null;
  // The clip file behind `sound`, deleted whenever the sound is unloaded
  // (finish, stop, or replacement), so a stopped reply leaves nothing in
  // the cache (Greptile T-Rex, PR #492).
  let activeUri: string | null = null;
  let playing = false;
  let generation = 0;

  const unload = async () => {
    const s = sound;
    const uri = activeUri;
    sound = null;
    activeUri = null;
    playing = false;
    if (uri) discardSpeechFile(uri);
    if (!s) return;
    try {
      await s.stopAsync();
    } catch {
      // Already stopped or never loaded.
    }
    try {
      await s.unloadAsync();
    } catch {
      // Already unloaded.
    }
  };

  return {
    isSpeaking: () => playing,
    stop: async () => {
      generation += 1;
      await unload();
    },
    play: async (uri: string) => {
      generation += 1;
      const mine = generation;
      await unload();
      try {
        // A recording session (the mic) routes output to the earpiece and
        // ducks playback; make sure the reply comes out of the speaker.
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      } catch {
        // Non-fatal: quieter playback until the next mode call.
      }
      if (mine !== generation) {
        discardSpeechFile(uri);
        return;
      }
      // Resolves when the clip ends or is stopped; REJECTS when the native
      // player cannot load or decode it, so the caller's catch reaches the
      // system-voice fallback instead of a silent reply (Greptile T-Rex, PR #492).
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err ?? 'audio failed')));
        };
        Audio.Sound.createAsync({ uri }, { shouldPlay: true }, (status: AVPlaybackStatus) => {
          if (!status.isLoaded) {
            if ('error' in status && status.error) {
              void unload().finally(() => fail(new Error(`audio: ${status.error}`)));
            }
            return;
          }
          if (status.didJustFinish) {
            playing = false;
            void unload().finally(finish);
          }
        })
          .then(({ sound: created }) => {
            if (mine !== generation) {
              // stop() or a newer play() won the race while loading.
              void created.unloadAsync().catch(() => {});
              discardSpeechFile(uri);
              finish();
              return;
            }
            sound = created;
            activeUri = uri;
            playing = true;
          })
          .catch((err: unknown) => {
            discardSpeechFile(uri);
            fail(err);
          });
      });
    },
  };
}
