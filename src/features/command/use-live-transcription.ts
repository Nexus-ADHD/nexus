/**
 * useLiveTranscription — wraps expo-speech-recognition (jamsch) into a
 * single hook that exposes interim + final transcripts and isRecognizing.
 *
 * Path C of the voice pipeline: SFSpeechRecognizer drives live preview
 * text above the orb while expo-av's Audio.Recording continues capturing
 * the canonical audio for Whisper. Both lifelines run concurrently —
 * iOS allows multiple readers of the .playAndRecord input bus when the
 * category matches (see feasibility spike notes).
 *
 * Audio-session lifecycle is intentionally NOT managed here. The
 * recognizer's start() activates the session; stopping does NOT
 * deactivate. The Command screen owns explicit audio-mode resets so
 * the .measurement mode the recognizer sets doesn't dampen subsequent
 * playback volume (see issue jamsch/expo-speech-recognition#72).
 */

import { useRef, useState } from 'react';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { accumulateTranscript } from './accumulate-transcript';

export interface UseLiveTranscriptionResult {
  /** Full session transcript-so-far while the user is speaking: accumulated
   * finalized segments + the in-flight segment. Updates live. */
  interimTranscript: string;
  /** Full accumulated final transcript for the session. Grows as each segment
   * finalizes across pauses; empty until the first final. */
  finalTranscript: string;
  /** True from 'start' event through 'end' event. */
  isRecognizing: boolean;
  /**
   * Whether speech recognition permission was granted on the most
   * recent start attempt. null = not yet asked.
   */
  speechGranted: boolean | null;
  /**
   * Last error surfaced by the recognizer — either pre-flight
   * (availability / locale / permission) or the async error event
   * fired by the lib after start(). Null when nothing has gone wrong
   * on the most recent attempt.
   */
  errorMessage: string | null;
  /** Start recognition. Returns true if successfully started. Pass
   * `{ continuous: true }` for paragraph/command capture that must not
   * auto-finalize on a pause. Segmented finals are accumulated internally
   * (see accumulateTranscript), so `finalTranscript` / `getLastFinal()` always
   * hold the FULL session transcript — callers no longer stitch segments. */
  start: (opts?: { continuous?: boolean }) => Promise<boolean>;
  /** Stop recognition. Does NOT deactivate the audio session. */
  stop: () => Promise<void>;
  /** Reset transcripts + state to idle. */
  reset: () => void;
  /**
   * The full accumulated final transcript for the session, even if the
   * consumer re-rendered after reset. Useful as a fallback when Whisper fails.
   */
  getLastFinal: () => string;
}

export function useLiveTranscription(): UseLiveTranscriptionResult {
  const [interimTranscript, setInterimTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [speechGranted, setSpeechGranted] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Persist beyond reset so the Whisper-failure fallback can still read
  // the recognizer's last guess.
  const lastFinalRef = useRef('');

  // Accumulated finalized segments for the CURRENT capture session. iOS
  // restarts its recognition task across a long pause, so we fold each isFinal
  // segment in here (see accumulateTranscript) rather than letting a new task's
  // empty/short transcript clobber what came before (NEX-149). Reset on every
  // start(); intentionally NOT cleared on reset() so getLastFinal() keeps the
  // full transcript as a Whisper-failure fallback.
  const committedRef = useRef('');

  // One-shot resolver set by start() so the next async error event can
  // resolve the racing promise with the error payload. The error event
  // listener checks this ref on every fire; start() clears it after
  // the race resolves either way.
  const pendingErrorResolverRef = useRef<((msg: string) => void) | null>(null);

  // One-shot resolver armed by stop() so it can wait for the recognizer's
  // FINAL transcript before returning. In continuous mode the tail of the
  // utterance is only flushed into an isFinal 'result' AFTER stop() is
  // called; resolving immediately would let callers read a truncated
  // transcript (the "cuts off the last few words" bug). Released by the
  // 'result'(isFinal), 'end', and 'error' listeners.
  const finalResultResolverRef = useRef<(() => void) | null>(null);
  const releaseFinalResult = (): void => {
    const resolve = finalResultResolverRef.current;
    if (resolve) {
      finalResultResolverRef.current = null;
      resolve();
    }
  };

  // Tracks an in-flight stop() so concurrent calls coalesce onto the same
  // promise instead of overwriting finalResultResolverRef and stranding the
  // first caller (e.g. a background-cleanup stop racing a user-initiated
  // stop).
  const stopInFlightRef = useRef<Promise<void> | null>(null);

  useSpeechRecognitionEvent('start', () => {
    setIsRecognizing(true);
  });

  useSpeechRecognitionEvent('end', () => {
    setIsRecognizing(false);
    // Fallback: release a waiting stop() even if no trailing isFinal
    // 'result' arrives after the flush.
    releaseFinalResult();
  });

  useSpeechRecognitionEvent('result', (ev: any) => {
    const segment = String(ev?.results?.[0]?.transcript ?? '');
    if (ev?.isFinal) {
      // Fold this segment into the session buffer so text spoken before a
      // pause survives the recognition-task restart (NEX-149).
      const full = accumulateTranscript(committedRef.current, segment);
      committedRef.current = full;
      lastFinalRef.current = full;
      setFinalTranscript(full);
      // Mirror into interim too: a stop() landing between segments (or a
      // consumer reading interim) should still see the complete transcript.
      setInterimTranscript(full);
      // The complete transcript landed — release any waiting stop().
      releaseFinalResult();
    } else {
      // Interim belongs to the in-flight segment only — show committed + live
      // so the preview reflects the whole utterance, not just this segment.
      setInterimTranscript(accumulateTranscript(committedRef.current, segment));
    }
  });

  useSpeechRecognitionEvent('error', (ev: any) => {
    const msg = String(ev?.message ?? ev?.error ?? 'Unknown recognizer error');
    setErrorMessage(msg);
    if (__DEV__) {
      console.log('[live-transcription] error', ev?.error, ev?.message);
    }
    // If start() is currently racing for an early-error signal, resolve
    // its promise so the caller knows the recognizer failed to attach.
    const resolver = pendingErrorResolverRef.current;
    if (resolver) {
      pendingErrorResolverRef.current = null;
      resolver(msg);
    }
    // Also release a waiting stop() — don't rely on a trailing 'end' always
    // following an error (a hard native failure may not emit one).
    releaseFinalResult();
  });

  const start = async (opts?: { continuous?: boolean }): Promise<boolean> => {
    // NOTE: do NOT call Audio.setAudioModeAsync here. The earlier patch
    // tried that, but our explicit category flip raced with expo-video's
    // session acquisition and triggered an infinite retry loop in the
    // recognizer that iOS eventually killed (SIGTERM 9). The recognizer
    // module manages the AVAudioSession category itself when starting;
    // the fix lives in <VoiceOrb>'s useVideoPlayer setting
    // audioMixingMode: 'mixWithOthers' so the player doesn't acquire
    // the session exclusively in the first place.
    setErrorMessage(null);

    // Pre-flight #1 — is recognition available on this device at all?
    // Catches airplane mode, framework disabled by parental controls,
    // unsupported device, etc. — bails before we burn a start() call.
    try {
      const available = ExpoSpeechRecognitionModule.isRecognitionAvailable();
      if (__DEV__) console.log('[live-transcription] availability', available);
      if (!available) {
        setErrorMessage('Speech recognition unavailable. Try a real device.');
        return false;
      }
    } catch (e) {
      if (__DEV__) console.log('[live-transcription] availability check failed', e);
    }

    try {
      if (__DEV__) {
        const perms = await ExpoSpeechRecognitionModule.getPermissionsAsync();
        console.log('[live-transcription] perms', perms);
      }
      const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      const granted = !!(result?.granted);
      setSpeechGranted(granted);
      if (!granted) {
        setErrorMessage('Microphone or speech recognition permission denied.');
        return false;
      }

      // Pre-flight #2 — is en-US installed for on-device recognition?
      // Server-side recognition (the default) routes through Apple's
      // speech servers, which are flaky from simulator and add network
      // latency on device. Prefer on-device when available.
      let requiresOnDevice = false;
      try {
        const locales = await ExpoSpeechRecognitionModule.getSupportedLocales({});
        const installed: string[] = Array.isArray(locales?.installedLocales)
          ? locales.installedLocales
          : [];
        if (installed.includes('en-US')) {
          requiresOnDevice = true;
        } else if (__DEV__) {
          console.warn(
            '[live-transcription] en-US not installed on-device — falling back to server recognition',
            locales,
          );
        }
      } catch (e) {
        if (__DEV__) console.warn('[live-transcription] getSupportedLocales failed', e);
      }

      setInterimTranscript('');
      setFinalTranscript('');
      lastFinalRef.current = '';
      committedRef.current = '';

      // Set up the error-race resolver BEFORE start() so the listener
      // doesn't miss an immediate error fire.
      const errorRace = new Promise<string | null>((resolve) => {
        pendingErrorResolverRef.current = (msg: string) => resolve(msg);
        // 500ms — long enough for kLSRErrorDomain 300 to fire (it
        // surfaces immediately on a bad session/asset state), short
        // enough that the user's "tap to listen" interaction still
        // feels instant. If no error fires in this window, we treat
        // the recognizer as successfully attached.
        setTimeout(() => {
          pendingErrorResolverRef.current = null;
          resolve(null);
        }, 500);
      });

      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        // Opt-in per call. The command/orb screen and horizon-review pass
        // continuous:true so iOS doesn't auto-finalize on the first pause and
        // truncate mid-sentence; the hook accumulates segmented finals
        // internally (see accumulateTranscript / committedRef). Single-
        // utterance callers (reflection-flow, mandate notes) leave it false.
        continuous: opts?.continuous ?? false,
        addsPunctuation: true,
        ...(requiresOnDevice ? { requiresOnDeviceRecognition: true } : {}),
      });

      const earlyError = await errorRace;
      if (earlyError) {
        // The async error event fired inside the race window — the
        // recognizer didn't actually attach. errorMessage was set by
        // the error listener.
        return false;
      }
      return true;
    } catch (e) {
      if (__DEV__) console.log('[live-transcription] start failed', e);
      setSpeechGranted(false);
      setErrorMessage(e instanceof Error ? e.message : 'Failed to start recognizer.');
      return false;
    }
  };

  const stop = async (): Promise<void> => {
    // Coalesce concurrent stop() calls. Without this, a second call would
    // overwrite finalResultResolverRef and the first call's timeout guard
    // (ref-equality) would then never resolve it — stranding the first
    // caller and never clearing isRecognizing. Returning the in-flight
    // promise makes both callers settle together.
    if (stopInFlightRef.current) return stopInFlightRef.current;

    // Arm the final-result waiter BEFORE stop() so we can't miss the flush.
    // stop() tells iOS to finalize; the recognizer then emits a final
    // isFinal 'result' (and/or 'end') carrying the tail. We wait for that
    // so getLastFinal() / finalTranscript hold the COMPLETE transcript. The
    // timeout fallback guarantees we never hang if neither event fires.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const settled = new Promise<void>((resolve) => {
      finalResultResolverRef.current = resolve;
      timeoutId = setTimeout(() => {
        if (finalResultResolverRef.current === resolve) {
          finalResultResolverRef.current = null;
          resolve();
        }
      }, 1200);
    });
    // Clear the fallback timer once the promise settles normally.
    settled.then(() => { if (timeoutId) clearTimeout(timeoutId); });

    const run = (async () => {
      try {
        ExpoSpeechRecognitionModule.stop();
      } catch {
        // Already stopped or never started — release the waiter now.
        releaseFinalResult();
      }
      await settled;
      setIsRecognizing(false);
      stopInFlightRef.current = null;
    })();
    stopInFlightRef.current = run;
    return run;
  };

  const reset = (): void => {
    setInterimTranscript('');
    setFinalTranscript('');
    setIsRecognizing(false);
  };

  const getLastFinal = (): string => lastFinalRef.current;

  return {
    interimTranscript,
    finalTranscript,
    isRecognizing,
    speechGranted,
    errorMessage,
    start,
    stop,
    reset,
    getLastFinal,
  };
}
