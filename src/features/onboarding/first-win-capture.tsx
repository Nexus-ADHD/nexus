/**
 * FirstWinCapture — NEX-193 win-first onboarding (ADHD Pivot · P2-d).
 *
 * The first voice interaction after name/phone, BEFORE mandate capture. The
 * user says one thing they want to do tomorrow; it materializes as a real Inbox
 * to-do (due tomorrow) shown in-screen — "I said a sentence and the app already
 * built the thing." Mandate capture (ReflectionFlow) becomes the second
 * invocation. Forgiving text fallback so a denied mic / failed STT is never a
 * dead end (UF-01 a11y floor). Research: TIER-11 §3.A, TIER-08 (confirm by
 * visible relocation, not a toast), §1.5 Law A.
 */

import React, { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import tokens from '@/src/theme/tokens';
import { useBreakpoints } from '@/src/theme/layout';
import { ambientGlow } from '@/src/theme/glow';
import { haptic } from '@/src/utils/haptics';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';
import { trackEvent } from '@/src/services/analytics';
import { useAppState } from '@/src/state/app-state';
import { useLiveTranscription } from '@/src/features/command/use-live-transcription';
import { useVoiceCaptureGuards } from '@/src/features/command/use-voice-capture-guards';
import { fallbackTitle } from '@/src/features/command/command-parser';
import { buildFirstWinCapture } from './build-first-win-capture';
import { buildFirstWinEmitProps, type FirstWinKey } from './build-first-win-emit-props';
import { VoiceOrb } from '../../../components/VoiceOrb';

const PROCESSING_HOLD_MS = 400;
const PLACEHOLDER = tokens.color.textDisabled;
// One-time marker so a kill/reload mid-onboarding (after the item is created
// but before activation finishes) doesn't re-ask and create a SECOND
// due-tomorrow task. Read by app/_layout.tsx to pre-satisfy the first-win gate;
// cleared by the Settings onboarding-replay reset.
export const FIRST_WIN_DONE_KEY = 'nexus_firstWinCaptured';

interface CreatedWin {
  id: string;
  title: string;
}

interface FirstWinCaptureProps {
  onComplete: () => void;
  // NEX-299: null until app/_layout.tsx's persisted-read effect resolves.
  // emit() omits the duration/backgrounding props (never fabricates 0/false)
  // while still null — see build-first-win-emit-props.ts.
  onboardingStartedAtMs: number | null;
  backgroundedDuringOnboarding: boolean;
}

export default function FirstWinCapture({
  onComplete,
  onboardingStartedAtMs,
  backgroundedDuringOnboarding,
}: FirstWinCaptureProps) {
  const insets = useSafeAreaInsets();
  // Adaptive layout: only the overlay content column is constrained on wide
  // viewports — the orb stays full-bleed.
  const { isWide, contentMaxWidth } = useBreakpoints();
  const live = useLiveTranscription();
  const addInboxTask = useAppState((s: any) => s.addInboxTask);
  const updateInboxTask = useAppState((s: any) => s.updateInboxTask);

  const [listening, setListening] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [showType, setShowType] = useState(false);
  const [typeBuffer, setTypeBuffer] = useState('');
  const [created, setCreated] = useState<CreatedWin | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');

  // Synchronous double-fire guard (per LEARNINGS 2026-06-10): a double tap or a
  // re-render must not create two inbox items. Claimed BEFORE the store write.
  const inFlightRef = useRef(false);
  // `starting` mirrors the start guard into state so the exit controls (Skip /
  // Type instead) are disabled while start() awaits permission — otherwise a
  // skip in that window unmounts the screen and the later start() resolve would
  // touch an unmounted component and leave the recognizer running into
  // ReflectionFlow.
  const [starting, setStarting] = useState(false);
  // The post-stop processing hold runs on a timer; clear it on unmount so a
  // mid-window "Skip" (onComplete → unmount) can't fire materialize afterward
  // and create an orphan Inbox item.
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetAudioMode = async () => {
    // The recognizer leaves the iOS session in record/.measurement mode, which
    // dampens later playback (jamsch#72). Ratchet it back, mirroring the
    // Command tab's live path. Non-fatal on failure.
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
    } catch {
      /* quieter playback until the next setAudioMode call */
    }
  };

  // Shared re-entrancy + lifecycle guard (NEX-193): owns the start in-flight
  // lock and mountedRef. Unmount teardown: cancel a pending processing hold so
  // it can't fire post-unmount, stop any in-flight transcription, and reset the
  // audio session (jamsch#72).
  const guards = useVoiceCaptureGuards(() => {
    if (processingTimerRef.current) clearTimeout(processingTimerRef.current);
    live.stop().catch(() => {});
    void resetAudioMode();
  });

  const emit = (key: FirstWinKey) =>
    void trackEvent('onboarding_step_completed', {
      ...buildFirstWinEmitProps(onboardingStartedAtMs, backgroundedDuringOnboarding, key),
    });

  const materialize = async (raw: string, via: 'voice' | 'text') => {
    if (inFlightRef.current || created) return;
    const text = raw.trim();
    if (!text) {
      // Empty transcript routes to the text fallback rather than saving a
      // generic "Captured thought" — never a confident-but-wrong save. No
      // analytics emit here: the terminal outcome ('fallback_text' on ADD, or
      // 'skipped') is what gets counted, so an empty result isn't conflated
      // with an actual mic denial.
      setVoiceError("Couldn't hear that. Type it instead.");
      setShowType(true);
      return;
    }
    inFlightRef.current = true;
    const cap = buildFirstWinCapture(text, new Date());
    let id: string;
    try {
      id = addInboxTask(cap.title, { dueDate: cap.dueDateKey, source: 'manual', status: 'UNPROCESSED' });
    } catch {
      inFlightRef.current = false;
      setVoiceError('Could not save that. Try again.');
      return;
    }
    // Persist the dedup marker BEFORE revealing the card (which exposes
    // CONTINUE) and await it, so the write can't lose a race with
    // finishOnboarding's later removeItem and wrongly persist past onboarding.
    // Read by _layout's first-win gate on a kill/reload.
    try {
      await AsyncStorage.setItem(FIRST_WIN_DONE_KEY, 'true');
    } catch {
      /* non-fatal — the in-memory gate still prevents a same-session re-create */
    }
    haptic('voiceSuccess');
    setCreated({ id, title: cap.title });
    emit(via === 'voice' ? 'captured' : 'fallback_text');
  };

  const handleOrbPress = async () => {
    if (processing || created) return;
    // One start/stop in flight at a time (NEXUS-5): reject a double tap
    // synchronously — before any haptic/state — covering BOTH the start and the
    // stop path, so live.start()/live.stop() can't fire twice in the window
    // before a setState re-render propagates.
    if (guards.isInFlight()) return;
    if (!listening) {
      setStarting(true);
      setVoiceError(null);
      haptic('voiceStart');
      try {
        // continuous so a mid-sentence pause doesn't auto-finalize the capture;
        // the user ends it with TAP WHEN DONE (matches the Command tab pattern).
        const ok = await guards.lockWhile(() => live.start({ continuous: true }));
        // If the screen was skipped/unmounted while start() awaited permission,
        // don't touch state — and stop the recognizer so it can't bleed into
        // ReflectionFlow.
        if (!guards.isMounted()) {
          if (ok) { live.stop().catch(() => {}); void resetAudioMode(); }
          return;
        }
        if (!ok) {
          setVoiceError('Microphone access denied. Type your win below.');
          setShowType(true);
          emit('voice_denied');
          return;
        }
        setListening(true);
      } finally {
        if (guards.isMounted()) setStarting(false);
      }
      return;
    }
    // listening → stop and process, under the same in-flight lock.
    await guards.lockWhile(async () => {
      setListening(false);
      setProcessing(true);
      await live.stop();
      await resetAudioMode();
      processingTimerRef.current = setTimeout(() => {
        // Guard against an unmount during the awaits above: if the screen was
        // skipped/onComplete'd, this timer was assigned after the unmount cleanup
        // ran, so bail rather than setState + materialize a stray Inbox capture
        // post-unmount (mirrors structured-start's hold-callback guard).
        if (!guards.isMounted()) return;
        const final = live.finalTranscript || live.getLastFinal() || live.interimTranscript;
        setProcessing(false);
        void materialize(final, 'voice');
      }, PROCESSING_HOLD_MS);
    });
  };

  const handleTypeSubmit = () => {
    void materialize(typeBuffer, 'text');
  };

  const startEdit = () => {
    if (!created) return;
    setEditBuffer(created.title);
    setEditing(true);
  };

  const saveEdit = () => {
    if (!created) return;
    // Run the edited title through the SAME normalization as initial creation
    // (trim + 60-char cap) so an edit can't bypass the Inbox title invariant
    // and overflow the card/row.
    const next = fallbackTitle(editBuffer);
    if (editBuffer.trim() && next !== created.title) {
      updateInboxTask(created.id, { title: next });
      setCreated({ ...created, title: next });
    }
    setEditing(false);
  };

  const handleContinue = () => {
    onComplete();
  };

  const handleSkip = () => {
    emit('skipped');
    onComplete();
  };

  const orbState: 'idle' | 'listening' = listening || processing ? 'listening' : 'idle';

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.root}>
      <VoiceOrb
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 300 }}
        state={orbState}
        onPress={created ? undefined : handleOrbPress}
        // Mirrors the visible status line below (the `starting / processing /
        // listening / idle` ladder) in the SAME order, so the two cannot
        // disagree. A binary listening-or-not label announced "Record your
        // first win" while the recording was still being transcribed, which
        // invites a VoiceOver user to start over mid-transcription.
        accessibilityLabel={
          starting
            ? 'Starting'
            : processing
              ? 'Processing your recording'
              : listening
                ? 'Stop recording'
                : 'Record your first win'
        }
      />

      {/* box-none: with the overlay now filling the screen (flex:1), blank
          regions must still pass taps through to the VoiceOrb behind it. */}
      <View style={[styles.overlay, { paddingBottom: insets.bottom + 24, alignItems: 'center' }]} pointerEvents="box-none">
        {/* Adaptive column: the orb stays full-bleed; only this content stack
            is constrained on wide viewports. box-none preserved so blank
            regions still fall through to the orb. */}
        <View style={{ width: '100%', maxWidth: isWide ? contentMaxWidth : undefined }} pointerEvents="box-none">
        {!created ? (
          <>
            <Text style={styles.eyebrow}>YOUR FIRST WIN</Text>
            <Text style={styles.prompt}>Say one thing you want to do tomorrow.</Text>

            {!!voiceError && <Text style={styles.error}>{voiceError}</Text>}

            {showType ? (
              <View style={styles.inputWrapper}>
                <TextInput
                  style={styles.input}
                  placeholder="One thing for tomorrow…"
                  placeholderTextColor={PLACEHOLDER}
                  value={typeBuffer}
                  onChangeText={setTypeBuffer}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={handleTypeSubmit}
                />
                <PrimaryPill fullWidth onPress={handleTypeSubmit} disabled={!typeBuffer.trim()}>
                  ADD
                </PrimaryPill>
              </View>
            ) : (
              <>
                {/* Tap the Eye to start; this micro-label tells the user HOW to
                    start AND stop — matching the Command tab's affordance so the
                    tap-to-speak / tap-when-done convention is consistent app-wide. */}
                <Text style={[styles.status, (starting || listening || processing) && styles.statusActive]}>
                  {starting ? 'STARTING…' : processing ? 'HEARING YOU…' : listening ? 'TAP WHEN DONE' : 'TAP TO SPEAK'}
                </Text>
                {/* Exit controls are hidden while the mic is starting/active so a
                    skip mid-startup can't unmount the screen out from under a
                    pending live.start() and strand the recognizer. */}
                {!starting && !listening && !processing && (
                  <Pressable
                    onPress={() => { setVoiceError(null); setShowType(true); }}
                    style={styles.linkBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Type instead"
                  >
                    <Text style={styles.link}>Type instead</Text>
                  </Pressable>
                )}
              </>
            )}

            {!starting && !listening && !processing && (
              <Pressable
                onPress={handleSkip}
                style={styles.linkBtn}
                accessibilityRole="button"
                accessibilityLabel="Skip for now"
              >
                <Text style={styles.skip}>Skip for now</Text>
              </Pressable>
            )}
          </>
        ) : editing ? (
          <View style={styles.inputWrapper}>
            <TextInput
              style={styles.input}
              value={editBuffer}
              onChangeText={setEditBuffer}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={saveEdit}
              accessibilityLabel="Edit your first win"
            />
            <PrimaryPill fullWidth onPress={saveEdit}>
              SAVE
            </PrimaryPill>
          </View>
        ) : (
          <>
            <Text style={styles.eyebrow}>TOMORROW</Text>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{created.title}</Text>
              <Text style={styles.cardSub}>On your Inbox, due tomorrow.</Text>
            </View>
            <PrimaryPill fullWidth onPress={handleContinue}>
              CONTINUE
            </PrimaryPill>
            <Pressable
              onPress={startEdit}
              style={styles.linkBtn}
              accessibilityRole="button"
              accessibilityLabel="Not right? Edit"
            >
              <Text style={styles.link}>Not right? Edit</Text>
            </Pressable>
          </>
        )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // Transparent so the global StarField shows through (matches reflection-flow).
  root: { flex: 1, backgroundColor: 'transparent' },
  // App Review 4.0 (2026-07-02 rejection): was absolutely positioned
  // (bottom: 0), which KeyboardAvoidingView's padding cannot move — the
  // keyboard covered the autoFocus input and ADD/SAVE. In-flow + flex-end
  // keeps the resting layout while the KAV lifts it above the keyboard.
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: tokens.spacing.lg,
    alignItems: 'center',
  },
  eyebrow: {
    ...tokens.type.labelTrackedLg,
    color: tokens.color.gold,
    marginBottom: tokens.spacing.sm,
  },
  prompt: {
    ...tokens.type.poeticMd,
    color: tokens.color.text,
    textAlign: 'center',
    marginBottom: tokens.spacing.md,
  },
  // Tap-to-speak / tap-when-done micro-label (matches the Command tab):
  // muted at rest, teal while the Eye is listening/processing.
  status: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textMuted,
    textAlign: 'center',
    marginVertical: tokens.spacing.sm,
  },
  statusActive: {
    color: tokens.color.teal,
  },
  error: {
    ...tokens.type.caption,
    color: tokens.color.stateError,
    textAlign: 'center',
    marginBottom: tokens.spacing.sm,
  },
  card: {
    width: '100%',
    backgroundColor: tokens.color.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    padding: tokens.spacing.lg,
    marginBottom: tokens.spacing.md,
    ...ambientGlow,
  },
  cardTitle: {
    ...tokens.type.titleSection,
    color: tokens.color.text,
    marginBottom: tokens.spacing.xs,
  },
  cardSub: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
  },
  inputWrapper: {
    width: '100%',
    backgroundColor: tokens.color.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    padding: tokens.spacing.md,
    ...ambientGlow,
  },
  input: {
    color: tokens.color.text,
    fontSize: 16,
    textAlign: 'center',
    marginBottom: tokens.spacing.sm,
  },
  linkBtn: {
    paddingVertical: tokens.spacing.sm,
  },
  link: {
    ...tokens.type.caption,
    color: tokens.color.textSecondary,
  },
  skip: {
    ...tokens.type.caption,
    color: tokens.color.textDisabled,
  },
});
