// NEX-260 (L-5) — Optional solo structured-start. Presence, not performance.
//
// A quiet, self-contained modal launched from the Command tab: name what you're
// about to do (voice OR text), see it reflected back, then OPTIONALLY hold a solo
// focus timer (default off), ending with a no-pressure acknowledgement. No
// streak, score, persisted metric, or social surface (§1.5 Laws B/C/E). The
// intention text is ephemeral — never persisted, never analytics-logged; STT is
// on-device (useLiveTranscription) and the reflection is a local string echo (no
// AI proxy call).
//
// Lifecycle: the PARENT mounts this conditionally ({show && <StructuredStart/>})
// so unmount fires every cleanup path (STT stop + interval clear).
//
// Accessibility (UF-01): the voice step always has the text fallback; the timer
// flow is entirely tap-only; the live numeral is hidden from the a11y tree and
// progress is announced at coarse milestones only (no per-second VoiceOver spam).
// Motion: no entrance animation (§1.4; also dodges the async reduce-motion race);
// the numerals update but nothing bounces. Opaque panel → Reduce-Transparency-safe.
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  AppState,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import tokens from '../../theme/tokens';
import { Sheet } from '@/src/components/ui/Sheet';
import { haptic } from '../../utils/haptics';
import { useLiveTranscription } from './use-live-transcription';
import { useVoiceCaptureGuards } from './use-voice-capture-guards';
import {
  DURATION_PRESETS_MS,
  formatRemaining,
  initialStructuredStartState,
  reduceStructuredStart,
} from './structured-start-machine';

interface Props {
  onDismiss: () => void;
}

// Mirror reflection-flow's processing hold so the final transcript lands before
// we read it (continuous STT releases the tail slightly after stop()).
const PROCESSING_HOLD_MS = 800;
const TICK_MS = 500;
const ONE_MINUTE_MS = 60_000;

function durationLabel(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

export function StructuredStart({ onDismiss }: Props) {
  const insets = useSafeAreaInsets();
  const [state, dispatch] = useReducer(reduceStructuredStart, undefined, initialStructuredStartState);
  const live = useLiveTranscription();

  // Voice sub-state within the 'stating' phase (the machine doesn't model the
  // transient listening/processing of the voice affordance).
  const [voiceState, setVoiceState] = useState<'idle' | 'listening' | 'processing'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  // Lifecycle refs.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const endAtMsRef = useRef<number | null>(null); // wall-clock end (component owns it)
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;
  const announcedOneMinRef = useRef(false);

  const clearInterval_ = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Shared re-entrancy + lifecycle guard (NEX-193): owns the in-flight lock and
  // mountedRef. Unmount teardown (the parent unmounts us on dismiss, the single
  // cleanup path): stop STT + clear all timers. This screen does NOT reset the
  // audio session (it never imports expo-av Audio) — that stays absent here.
  const guards = useVoiceCaptureGuards(() => {
    live.stop().catch(() => {});
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    clearInterval_();
  });

  // Run the countdown interval while running. The tick reads wall-clock
  // (endAtMs - now), so JS-timer drift / OS throttling can't accumulate error.
  useEffect(() => {
    if (state.phase !== 'running') {
      clearInterval_();
      return;
    }
    const tick = () => {
      const remaining = (endAtMsRef.current ?? Date.now()) - Date.now();
      if (remaining <= ONE_MINUTE_MS && !announcedOneMinRef.current && remaining > 0) {
        announcedOneMinRef.current = true;
        AccessibilityInfo.announceForAccessibility('One minute left.');
      }
      dispatch({ type: 'tick', remainingMs: remaining });
    };
    tick(); // immediate, so the display is fresh on start AND on resume
    intervalRef.current = setInterval(tick, TICK_MS);
    return clearInterval_;
  }, [state.phase, clearInterval_]);

  // Foreground correction: iOS suspends JS timers while backgrounded, so on
  // return we recompute immediately from the absolute endAtMs (which may have
  // already elapsed → auto-done). Paused timers are untouched (phase guard).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && phaseRef.current === 'running') {
        dispatch({ type: 'tick', remainingMs: (endAtMsRef.current ?? Date.now()) - Date.now() });
      }
    });
    return () => sub.remove();
  }, []);

  // Announce the quiet close once (coarse milestone, not per-second).
  useEffect(() => {
    if (state.phase === 'done') AccessibilityInfo.announceForAccessibility('Done. You were here.');
  }, [state.phase]);

  // ── Voice (stating) ────────────────────────────────────────────────────────
  const handleSpeakPress = async () => {
    if (voiceState === 'processing') return;
    // One start/stop in flight at a time: reject a double-tap synchronously,
    // covering BOTH paths — the stop path sets voiceState='processing' but that
    // doesn't propagate before a rapid second tap could call live.stop() twice.
    if (guards.isInFlight()) return;
    if (voiceState === 'listening') {
      // Stop → hold → read the final transcript, under the in-flight lock.
      await guards.lockWhile(async () => {
        setVoiceState('processing');
        await live.stop().catch(() => {});
        holdTimerRef.current = setTimeout(() => {
          if (!guards.isMounted()) return;
          const final = (live.finalTranscript || live.getLastFinal() || live.interimTranscript || '').trim();
          if (!final) {
            setVoiceState('idle');
            live.reset();
            setVoiceError("Couldn't hear that. Try again, or type it below.");
            return;
          }
          setVoiceState('idle');
          live.reset();
          commitIntention(final);
        }, PROCESSING_HOLD_MS);
      });
      return;
    }
    // idle → start. `.catch(() => false)` keeps this screen's defensive
    // "a thrown start() reads as denied" behavior.
    setVoiceError(null);
    const ok = await guards.lockWhile(() => live.start().catch(() => false));
    if (!guards.isMounted()) {
      live.stop().catch(() => {});
      return;
    }
    if (!ok) {
      setVoiceError('Microphone access is off. Type what you are about to do below.');
      return;
    }
    haptic('voiceStart');
    setVoiceState('listening');
  };

  const commitIntention = (text: string) => {
    dispatch({ type: 'set_intention', text });
    dispatch({ type: 'reflect' });
    haptic('buttonSecondary');
  };

  const handleTypedSubmit = () => {
    const trimmed = typed.trim();
    if (!trimmed) return;
    Keyboard.dismiss();
    commitIntention(trimmed);
  };

  // ── Timer controls ──────────────────────────────────────────────────────────
  const handleStartTimer = (durationMs: number) => {
    if (phaseRef.current !== 'timer_offer') return; // double-tap guard (no double announce / endAt nudge)
    endAtMsRef.current = Date.now() + durationMs;
    announcedOneMinRef.current = false;
    dispatch({ type: 'start_timer', durationMs });
    haptic('buttonPrimary');
    AccessibilityInfo.announceForAccessibility(`Focus timer started, ${durationLabel(durationMs)}.`);
  };
  const handlePause = () => {
    if (phaseRef.current !== 'running') return; // double-tap guard
    dispatch({ type: 'pause' });
    haptic('buttonSecondary');
  };
  const handleResume = () => {
    if (phaseRef.current !== 'paused') return; // double-tap guard (no endAt re-anchor on a stale tap)
    // Re-anchor the wall-clock end to now + whatever remained.
    endAtMsRef.current = Date.now() + (state.remainingMs ?? 0);
    dispatch({ type: 'resume' });
    haptic('buttonSecondary');
  };
  const handleFinish = () => {
    dispatch({ type: 'finish' });
    haptic('buttonSecondary');
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <Sheet
      variant="center"
      // The phase machine drives its own transitions; a second one fights it.
      animation="none"
      // Not backdrop-dismissible: there is an explicit CLOSE, and a stray tap
      // mid-utterance would lose the transcript.
      dismissOnBackdropPress={false}
      onDismiss={onDismiss}
      accessibilityLabel="Structured start"
      style={{ marginTop: insets.top + tokens.spacing.lg, marginBottom: insets.bottom + tokens.spacing.lg }}
    >
      <Pressable
        onPress={onDismiss}
        hitSlop={12}
        style={styles.close}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Text style={styles.closeText}>CLOSE</Text>
      </Pressable>

      {state.phase === 'stating' && (
        <View style={styles.body}>
          <Text style={styles.prompt}>What are you about to do?</Text>
          <Pressable
            onPress={handleSpeakPress}
            style={[styles.speakBtn, voiceState === 'listening' && styles.speakBtnActive]}
            accessibilityRole="button"
            accessibilityLabel={
              voiceState === 'listening'
                ? 'Listening. Tap to stop.'
                : voiceState === 'processing'
                  ? 'Processing'
                  : 'Tap to speak what you are about to do'
            }
          >
            <Text style={[styles.speakText, voiceState === 'listening' && styles.speakTextActive]}>
              {voiceState === 'listening'
                ? 'LISTENING · TAP TO STOP'
                : voiceState === 'processing'
                  ? 'ONE MOMENT'
                  : 'TAP TO SPEAK'}
            </Text>
          </Pressable>
          <TextInput
            style={styles.input}
            placeholder="Or type what you are about to do..."
            placeholderTextColor={tokens.color.textMuted}
            value={typed}
            onChangeText={(t) => {
              if (voiceError) setVoiceError(null);
              setTyped(t);
            }}
            onSubmitEditing={handleTypedSubmit}
            returnKeyType="done"
            autoCorrect
            accessibilityLabel="Type what you are about to do"
          />
          {voiceError && <Text style={styles.error}>{voiceError}</Text>}
        </View>
      )}

      {state.phase === 'reflecting' && (
        <View style={styles.body}>
          <Text style={styles.reflectionQuote}>{`"${state.intention}"`}</Text>
          <Text style={styles.reflectionSteady}>This is what you named.</Text>
          <Pressable
            onPress={onDismiss}
            style={styles.primaryBtn}
            accessibilityRole="button"
            accessibilityLabel="Begin"
          >
            <Text style={styles.primaryBtnText}>BEGIN</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              dispatch({ type: 'offer_timer' });
              haptic('buttonSecondary');
            }}
            style={styles.secondaryBtn}
            accessibilityRole="button"
            accessibilityLabel="Start a focus timer"
          >
            <Text style={styles.secondaryBtnText}>START A FOCUS TIMER</Text>
          </Pressable>
        </View>
      )}

      {state.phase === 'timer_offer' && (
        <View style={styles.body}>
          <Text style={styles.prompt}>How long?</Text>
          <View style={styles.chipRow}>
            {DURATION_PRESETS_MS.map((ms) => (
              <Pressable
                key={ms}
                onPress={() => handleStartTimer(ms)}
                style={styles.chip}
                accessibilityRole="button"
                accessibilityLabel={`Focus for ${durationLabel(ms)}`}
              >
                <Text style={styles.chipText}>{durationLabel(ms)}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={onDismiss}
            style={styles.secondaryBtn}
            accessibilityRole="button"
            accessibilityLabel="Just begin, no timer"
          >
            <Text style={styles.secondaryBtnText}>JUST BEGIN</Text>
          </Pressable>
        </View>
      )}

      {(state.phase === 'running' || state.phase === 'paused') && (
        <View
          style={styles.body}
          accessibilityLabel={`Focus timer ${state.phase === 'paused' ? 'paused' : 'running'}`}
        >
          <Text style={styles.timerIntention} numberOfLines={2}>
            {state.intention}
          </Text>
          <Text
            style={styles.timerNumeral}
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          >
            {formatRemaining(state.remainingMs)}
          </Text>
          <View style={styles.chipRow}>
            <Pressable
              onPress={state.phase === 'paused' ? handleResume : handlePause}
              style={styles.secondaryBtn}
              accessibilityRole="button"
              accessibilityLabel={state.phase === 'paused' ? 'Resume' : 'Pause'}
            >
              <Text style={styles.secondaryBtnText}>{state.phase === 'paused' ? 'RESUME' : 'PAUSE'}</Text>
            </Pressable>
            <Pressable
              onPress={handleFinish}
              style={styles.secondaryBtn}
              accessibilityRole="button"
              accessibilityLabel="I am done"
            >
              <Text style={styles.secondaryBtnText}>{"I'M DONE"}</Text>
            </Pressable>
          </View>
        </View>
      )}

      {state.phase === 'done' && (
        <View style={styles.body}>
          <Text style={styles.reflectionSteady}>Done. You were here.</Text>
          <Pressable
            onPress={onDismiss}
            style={styles.primaryBtn}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Text style={styles.primaryBtnText}>CLOSE</Text>
          </Pressable>
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // Near-opaque elevated panel, no BlurView → Reduce-Transparency-safe (no blur
  // to strip; the ~3% field bleed at 0.97 alpha is imperceptible behind content).
  close: {
    alignSelf: 'flex-end',
    paddingVertical: tokens.spacing.xs,
  },
  closeText: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textMuted,
  },
  body: {
    alignItems: 'center',
    paddingVertical: tokens.spacing.md,
    gap: tokens.spacing.md,
  },
  prompt: {
    ...tokens.type.poeticMd,
    color: tokens.color.text,
    textAlign: 'center',
  },
  speakBtn: {
    paddingVertical: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.xl,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    backgroundColor: 'transparent',
  },
  speakBtnActive: {
    borderColor: tokens.color.teal,
    backgroundColor: tokens.color.tealWash,
  },
  speakText: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textSecondary,
  },
  speakTextActive: {
    color: tokens.color.teal,
  },
  input: {
    width: '100%',
    borderBottomWidth: 1,
    borderBottomColor: tokens.color.goldHairline,
    paddingVertical: tokens.spacing.sm,
    color: tokens.color.text,
    ...tokens.type.titleSection,
    textAlign: 'center',
  },
  error: {
    color: tokens.color.stateError,
    ...tokens.type.caption,
    textAlign: 'center',
  },
  reflectionQuote: {
    ...tokens.type.poeticMd,
    color: tokens.color.text,
    textAlign: 'center',
  },
  reflectionSteady: {
    ...tokens.type.bodyMd,
    color: tokens.color.textSecondary,
    textAlign: 'center',
  },
  timerIntention: {
    ...tokens.type.bodyMd,
    color: tokens.color.textSecondary,
    textAlign: 'center',
  },
  timerNumeral: {
    ...tokens.type.heroNumeric,
    color: tokens.color.text,
    textAlign: 'center',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: tokens.spacing.sm,
  },
  chip: {
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.lg,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
  },
  chipText: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textSecondary,
  },
  primaryBtn: {
    width: '100%',
    paddingVertical: tokens.spacing.md,
    borderRadius: 999,
    backgroundColor: tokens.color.text,
    alignItems: 'center',
  },
  primaryBtnText: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textInverse,
  },
  secondaryBtn: {
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.lg,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    alignItems: 'center',
  },
  secondaryBtnText: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textSecondary,
  },
});
