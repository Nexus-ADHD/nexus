// NEX-37 — Orb-driven reflection. One mounted screen, persistent orb,
// internal state machine across all four questions. No remounting
// between questions. Visual register mirrors the Command tab exactly:
// full-bleed VoiceOrb background + LinearGradient scrim + absolute
// bottom overlay.
//
// State machine:
//   - questionIndex (0..3) + disambiguationActive: which prompt shows
//   - orbState ('idle' | 'listening' | 'processing'): drives caption +
//     orb props (processing maps to 'listening' visually so the orb
//     keeps its pulse during the 800ms hold)
//   - mode ('voice' | 'type'): voice-first; resets to voice each
//     question
//   - answers: Record<CardKey, string> — accumulator
//
// Voice path uses the same useLiveTranscription hook the Command tab
// uses. The previous expo-av + Whisper path retired with NEX-37.
//
// Replaces the previous four-card paged design from NEX-26 phase B.
// Preserved byte-for-byte: the four question strings, disambiguation
// copy + options, shouldDisambiguate() gate location, and the
// "Focus area: {answer}." bestVersion suffix on disambiguation.
//
// Out of scope: PreparingInterstitial, ReviewScreen, Pulse schema —
// all untouched.

import React, { useEffect, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import tokens from '@/src/theme/tokens';
import { useBreakpoints } from '@/src/theme/layout';
import { ambientGlow } from '@/src/theme/glow';
import { haptic } from '@/src/utils/haptics';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';
import {
  shouldDisambiguate,
  type ReflectionInput,
} from '@/src/services/pulse-recommendations';
import { useLiveTranscription } from '@/src/features/command/use-live-transcription';
import { VoiceOrb } from '../../../components/VoiceOrb';

// ─── Constants ───────────────────────────────────────────────────────────────

type CardKey = 'bestVersion' | 'stop' | 'continue' | 'focus';

interface Prompt {
  key: CardKey;
  question: string;
  example: string;
}

// Locked copy. Questions preserved verbatim from NEX-26. Example
// answers approved as part of NEX-37 — each is a short voice-matched
// hint shown faded under the question.
const PROMPTS: readonly Prompt[] = [
  {
    key: 'bestVersion',
    question: 'What does the best version of you look like?',
    example:
      'I want to be present with my family, do work that matters, write again, take care of my body. I want to be the kind of person my kids respect.',
  },
  {
    key: 'stop',
    question: 'What do you want to stop?',
    example:
      'Refreshing email before coffee. Scrolling past midnight. Saying yes when I mean no.',
  },
  {
    key: 'continue',
    question: 'What do you want to continue?',
    example:
      'Morning runs. The way I show up for my team. Saturday calls with my dad.',
  },
  {
    key: 'focus',
    question: 'What do you want to focus on moving forward?',
    example:
      "Finishing what I start. Building something I'd put my name on. Less surface, more depth.",
  },
];

// Mirror pulse-recommendations.ts's DISAMBIGUATION_PROMPT exactly. The
// gate is shouldDisambiguate() (no AI call); if these strings drift
// the user hits a different question than the service is asking about.
const DISAMBIGUATION_QUESTION =
  'Tell me a bit more. What does that version of you do differently?';
const DISAMBIGUATION_OPTIONS: readonly string[] = [
  'Body and health',
  'Work and craft',
  'Family and relationships',
  'Mind and meaning',
];

const QUESTION_FADE_OUT_MS = 200;
const QUESTION_FADE_IN_MS = 400;
const PROCESSING_HOLD_MS = 800;
const DOT_TRANSITION_MS = 200;

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  onComplete: (reflection: ReflectionInput) => void;
  onCancel?: () => void;
  /**
   * NEX-35: seed the four answer fields when the flow is re-entered
   * from the retry screen's "Edit reflection" path. Lets the user
   * fix a thin reflection without losing their prior input.
   */
  initialAnswers?: Partial<Record<CardKey, string>>;
}

// ─── ReflectionFlow ──────────────────────────────────────────────────────────

export default function ReflectionFlow({ onComplete, onCancel, initialAnswers }: Props) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [orbState, setOrbState] = useState<'idle' | 'listening' | 'processing'>('idle');
  const [disambiguationActive, setDisambiguationActive] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [typeBuffer, setTypeBuffer] = useState('');
  // The multiline input has no Return-to-submit, so without this the keyboard
  // can only be dismissed by submitting. Tracked so an orb tap can dismiss it.
  const [inputFocused, setInputFocused] = useState(false);
  const [answers, setAnswers] = useState<Record<CardKey, string>>(() => ({
    bestVersion: initialAnswers?.bestVersion ?? '',
    stop:        initialAnswers?.stop        ?? '',
    continue:    initialAnswers?.continue    ?? '',
    focus:       initialAnswers?.focus       ?? '',
  }));

  const liveTranscript = useLiveTranscription();
  const insets = useSafeAreaInsets();
  // Adaptive layout: only the overlay content column is constrained on wide
  // viewports — the orb and gradient stay full-bleed.
  const { isWide, contentMaxWidth } = useBreakpoints();

  // Reanimated shared values for question cross-fade. The input field
  // is always visible now (no voice/type mode toggle); both affordances
  // sit side by side via the orb (voice) and the input (type).
  const questionOpacity = useSharedValue(1);

  const questionAnimatedStyle = useAnimatedStyle(() => ({
    opacity: questionOpacity.value,
  }));

  // Stop any in-flight transcription on unmount.
  useEffect(() => {
    return () => {
      liveTranscript.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentQuestion = disambiguationActive
    ? DISAMBIGUATION_QUESTION
    : PROMPTS[questionIndex].question;
  const currentExample = disambiguationActive
    ? null
    : PROMPTS[questionIndex].example;

  // buildReflection with optional override so callers writing the
  // last answer don't read stale React state on the same tick.
  const buildReflectionWithOverride = (
    override?: Partial<Record<CardKey, string>>,
  ): ReflectionInput => ({
    bestVersion: (override?.bestVersion ?? answers.bestVersion).trim(),
    stop: (override?.stop ?? answers.stop).trim(),
    continue: (override?.continue ?? answers.continue).trim(),
    focus: (override?.focus ?? answers.focus).trim(),
  });

  // ── Cross-fade helper ────────────────────────────────────────────────────

  const crossFadeAdvance = (mutate: () => void) => {
    const applyMutationAndFadeIn = () => {
      mutate();
      questionOpacity.value = withTiming(1, {
        duration: QUESTION_FADE_IN_MS,
        easing: Easing.out(Easing.cubic),
      });
    };

    questionOpacity.value = withTiming(
      0,
      { duration: QUESTION_FADE_OUT_MS, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(applyMutationAndFadeIn)();
      },
    );
  };

  // ── Answer pipeline ──────────────────────────────────────────────────────

  const applyAnswerAndAdvance = (key: CardKey, text: string) => {
    const trimmed = text.trim();
    setAnswers((prev) => ({ ...prev, [key]: trimmed }));
    liveTranscript.reset();

    if (questionIndex < PROMPTS.length - 1) {
      crossFadeAdvance(() => {
        setQuestionIndex((i) => i + 1);
        setOrbState('idle');
        setTypeBuffer('');
        setVoiceError(null);
      });
      return;
    }

    // Last question — gate on disambiguation using the just-written value.
    const reflection = buildReflectionWithOverride({ [key]: trimmed });
    if (shouldDisambiguate(reflection)) {
      crossFadeAdvance(() => {
        setDisambiguationActive(true);
        setOrbState('idle');
        setTypeBuffer('');
        setVoiceError(null);
      });
    } else {
      onComplete(reflection);
    }
  };

  // Disambiguation answer (chip / voice / type all converge here).
  // Append "Focus area: {answer}." to bestVersion so Pulse can see the
  // clarification without parsing a new field.
  const handleDisambiguationAnswer = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const current = answers.bestVersion.trim();
    const suffix = `Focus area: ${trimmed}.`;
    const augmented = current ? `${current} ${suffix}` : suffix;
    const reflection: ReflectionInput = {
      ...buildReflectionWithOverride(),
      bestVersion: augmented,
    };
    onComplete(reflection);
  };

  // ── Orb tap ──────────────────────────────────────────────────────────────

  const handleOrbPress = async () => {
    if (orbState === 'processing') return;

    // If the keyboard is up from the type input, the first orb tap just
    // dismisses it (the orb fills the screen, so this is tap-anywhere-to-
    // dismiss) rather than starting voice. blur fires onBlur → inputFocused
    // clears, so the next tap records.
    if (inputFocused) {
      Keyboard.dismiss();
      return;
    }

    if (orbState === 'idle') {
      setVoiceError(null);
      const ok = await liveTranscript.start();
      if (!ok) {
        setVoiceError('Microphone access denied. Type your answer below.');
        return;
      }
      setOrbState('listening');
      return;
    }

    // orbState === 'listening' → stop and process.
    await liveTranscript.stop();
    setOrbState('processing');

    setTimeout(() => {
      const final =
        liveTranscript.finalTranscript ||
        liveTranscript.getLastFinal() ||
        liveTranscript.interimTranscript;
      const trimmed = final.trim();

      if (!trimmed) {
        setOrbState('idle');
        liveTranscript.reset();
        setVoiceError("Couldn't hear that. Try again.");
        return;
      }

      if (disambiguationActive) {
        // Voice answer path keeps its own haptic (no kit button involved);
        // the typed DONE path relies on the kit's press-in haptic (§19).
        haptic('dragDrop');
        handleDisambiguationAnswer(trimmed);
        return;
      }
      const currentKey = PROMPTS[questionIndex].key;
      applyAnswerAndAdvance(currentKey, trimmed);
    }, PROCESSING_HOLD_MS);
  };

  // ── Type mode ────────────────────────────────────────────────────────────

  const handleTypeSubmit = () => {
    const trimmed = typeBuffer.trim();
    if (!trimmed) return;
    if (disambiguationActive) {
      handleDisambiguationAnswer(trimmed);
      return;
    }
    const currentKey = PROMPTS[questionIndex].key;
    applyAnswerAndAdvance(currentKey, trimmed);
  };

  // ── Caption ──────────────────────────────────────────────────────────────
  // Tap-to-speak / tap-when-done affordance (consistent with the Command tab
  // and FirstWinCapture): at rest it tells the user how to start; while
  // listening it tells them they end the capture with a second tap.
  let caption: string | null = 'TAP TO SPEAK';
  if (orbState === 'listening') caption = 'TAP WHEN DONE';
  else if (orbState === 'processing') caption = 'HEARING YOU…';

  // ── Progress dots ────────────────────────────────────────────────────────

  // 4 dots normally; the 5th surfaces when disambiguation is active.
  const totalDots = disambiguationActive ? 5 : 4;
  const activeDotIndex = disambiguationActive ? 4 : questionIndex;

  // VoiceOrb only knows idle/listening/talking. Map our processing
  // state to listening so the visual pulse continues during the
  // 800ms hold while we wait for the transcript.
  const orbVisualState: 'idle' | 'listening' =
    orbState === 'processing' ? 'listening' : orbState;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.root}
    >
      <VoiceOrb
        // 260 = clearance below the orb halo for the question + input +
        // example stack without overlapping the iris. Onboarding has
        // more overlay content than Command, so the orb is sized
        // smaller here.
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 260 }}
        state={orbVisualState}
        onPress={handleOrbPress}
        // Covers all three orbState values, matching the visible caption above.
        // A binary label announced "Record your reflection" during the
        // processing hold, inviting a restart while the transcript was still
        // being resolved.
        accessibilityLabel={
          orbState === 'listening'
            ? 'Stop recording'
            : orbState === 'processing'
              ? 'Processing your reflection'
              : 'Record your reflection'
        }
      />
      <LinearGradient
        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.65)', 'rgba(0,0,0,0.88)']}
        locations={[0, 0.55, 1]}
        pointerEvents="none"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%' }}
      />
      {/* Top progress dots — anchored just below the safe-area top.
          Matches the NEX-37 spec: dots live at the top of the screen,
          not above the question. */}
      <View
        style={[styles.topDotsRow, { top: insets.top + 16 }]}
        pointerEvents="none"
      >
        {Array.from({ length: totalDots }).map((_, i) => (
          <ProgressDot
            key={i}
            isActive={i === activeDotIndex}
            isPassed={i < activeDotIndex}
          />
        ))}
      </View>

      {/* pointerEvents="box-none" lets blank overlay regions fall through
          to the orb's Pressable so the orb stays tappable everywhere
          except over interactive controls (input / chips / links). */}
      <View
        style={[styles.overlay, { paddingBottom: insets.bottom + 24, alignItems: 'center' }]}
        pointerEvents="box-none"
      >
        {/* Adaptive column: orb + gradient stay full-bleed; only this content
            stack is constrained on wide viewports. box-none preserved so blank
            regions still fall through to the orb. */}
        <View style={{ width: '100%', maxWidth: isWide ? contentMaxWidth : undefined }} pointerEvents="box-none">
        {/* Question text — matches Command tab's "What needs to happen
            today?" exactly: tokens.type.poeticMd (Fraunces Light Italic,
            22pt). Cross-faded on question transition. */}
        <Animated.Text
          style={[styles.question, questionAnimatedStyle]}
          numberOfLines={4}
        >
          {currentQuestion}
        </Animated.Text>

        {/* Input field — full Command parity (manualInputWrapper + manualInput).
            Always visible; replaces the previous "Type instead" toggle. */}
        <View style={styles.inputWrapper}>
          <TextInput
            style={styles.input}
            placeholder="Type or tap the orb to speak..."
            placeholderTextColor={tokens.color.textDisabled}
            value={typeBuffer}
            onChangeText={setTypeBuffer}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            multiline
            textAlignVertical="top"
          />
        </View>

        {/* DONE pill — surfaces only when there's content to submit.
            Routes through the same handleTypeSubmit auto-advance path
            as voice answers. Per decision F: no Enter-key submission
            (multiline keeps newlines). */}
        {!!typeBuffer.trim() && (
          <PrimaryPill
            onPress={handleTypeSubmit}
            style={{ marginTop: tokens.spacing.sm, alignSelf: 'center' }}
          >
            DONE
          </PrimaryPill>
        )}

        {/* Voice caption (fixed height to prevent jitter). Always rendered;
            text + style branch off orbState. */}
        <Animated.View style={[styles.captionRow, questionAnimatedStyle]}>
          <Text style={styles.captionText}>{caption ?? ' '}</Text>
        </Animated.View>

        {/* Example card OR disambiguation chips. Example card mirrors
            the Pulse card's shape: surface bg, 20pt radius, tealWash
            border, 20pt padding. EXAMPLE label uses the same tracked-
            caps style as the Pulse card's "PULSE" label. Hidden while the
            input is focused — with the overlay now riding above the
            keyboard, this stack must not push the input/DONE off-screen
            on short (keyboard-up) viewports; blur restores it. */}
        {inputFocused ? null : disambiguationActive ? (
          <View style={styles.chipsGrid}>
            {DISAMBIGUATION_OPTIONS.map((option) => (
              <Pressable
                key={option}
                onPress={() => {
                  haptic('dragDrop');
                  handleDisambiguationAnswer(option);
                }}
                style={styles.chip}
                accessibilityRole="button"
                accessibilityLabel={option}
              >
                <Text style={styles.chipText}>{option}</Text>
              </Pressable>
            ))}
          </View>
        ) : currentExample ? (
          <Animated.View style={[styles.exampleCard, questionAnimatedStyle]}>
            <View style={styles.exampleHeader}>
              <Text style={styles.exampleLabel}>EXAMPLE</Text>
            </View>
            <Text style={styles.exampleBody}>{currentExample}</Text>
          </Animated.View>
        ) : null}

        {/* Voice error */}
        {voiceError && <Text style={styles.errorText}>{voiceError}</Text>}

        {/* Cancel — only at questionIndex 0 and not in disambiguation */}
        {questionIndex === 0 && !disambiguationActive && onCancel && (
          <Pressable
            onPress={onCancel}
            style={styles.cancelLink}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── ProgressDot ────────────────────────────────────────────────────────────

function ProgressDot({
  isActive,
  isPassed,
}: {
  isActive: boolean;
  isPassed: boolean;
}) {
  const isOn = isActive || isPassed;
  const widthSV = useSharedValue(isActive ? 24 : 8);
  const opacitySV = useSharedValue(isOn ? 1 : 0.25);

  useEffect(() => {
    widthSV.value = withTiming(isActive ? 24 : 8, { duration: DOT_TRANSITION_MS });
    opacitySV.value = withTiming(isOn ? 1 : 0.25, { duration: DOT_TRANSITION_MS });
  }, [isActive, isOn, widthSV, opacitySV]);

  const animatedStyle = useAnimatedStyle(() => ({
    width: widthSV.value,
    opacity: opacitySV.value,
  }));

  return <Animated.View style={[styles.dot, animatedStyle]} />;
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Transparent so the global StarField (mounted as the first child of
  // KeyboardAvoidingView) shows through. Matches Command tab's
  // `styles.container: { flex: 1, backgroundColor: 'transparent' }`.
  root: { flex: 1, backgroundColor: 'transparent' },
  // App Review 4.0 (2026-07-02 rejection): this stack was absolutely
  // positioned (bottom: 24), so KeyboardAvoidingView's padding never moved
  // it and the keyboard covered the input + DONE pill (unpassable on iPad's
  // taller keyboard). In-flow + flex-end keeps the same resting position
  // while letting the KAV padding lift it above the keyboard. Bottom
  // padding (insets.bottom + 24) is applied inline in the render. No
  // alignItems — children that need full width set width: '100%'.
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: tokens.spacing.lg,
  },
  topDotsRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    gap: tokens.spacing.xs,
    justifyContent: 'center',
  },
  dot: {
    height: 8,
    borderRadius: 4,
    backgroundColor: tokens.color.gold,
  },
  question: {
    // Matches Command tab's "What needs to happen today?" exactly —
    // tokens.type.poeticMd (Fraunces Light Italic, 22pt). Spread first,
    // overrides after (color/textAlign/marginBottom).
    ...tokens.type.poeticMd,
    color: tokens.color.text,
    textAlign: 'center',
    marginBottom: tokens.spacing.md,
  },
  // Input field — clones Command tab's manualInputWrapper + manualInput.
  inputWrapper: {
    width: '100%',
    backgroundColor: tokens.color.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    padding: 15,
    ...ambientGlow,
  },
  input: {
    color: tokens.color.text,
    fontSize: 14,
    textAlign: 'center',
    // Long typed answers scroll inside the field instead of growing the
    // multiline input until the DONE pill is pushed off-screen.
    maxHeight: 120,
  },
  // Example card — clones Pulse card's pulseCard + sectionLabel shape.
  exampleCard: {
    width: '100%',
    backgroundColor: tokens.color.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: tokens.color.tealWash,
    padding: 20,
    marginTop: tokens.spacing.md,
  },
  exampleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  exampleLabel: {
    color: tokens.color.textMuted,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 3,
  },
  exampleBody: {
    color: tokens.color.text,
    fontSize: 14,
    lineHeight: 21,
    fontStyle: 'italic',
  },
  chipsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: tokens.spacing.sm,
    justifyContent: 'center',
    marginBottom: tokens.spacing.md,
  },
  chip: {
    backgroundColor: tokens.color.surfaceElevated,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    borderRadius: 14,
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    minWidth: 150,
    alignItems: 'center',
  },
  chipText: {
    color: tokens.color.text,
    fontSize: 14,
    fontWeight: '600',
  },
  captionRow: {
    width: '100%',
    height: 18,
    justifyContent: 'center',
    marginBottom: tokens.spacing.md,
  },
  captionText: {
    color: tokens.color.gold,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 4,
    textAlign: 'center',
  },
  errorText: {
    width: '100%',
    color: tokens.color.stateError,
    fontSize: 13,
    textAlign: 'center',
    marginTop: tokens.spacing.sm,
  },
  cancelLink: {
    padding: tokens.spacing.xs,
    alignSelf: 'center',
  },
  cancelText: {
    color: tokens.color.textDisabled,
    fontSize: 12,
    letterSpacing: 1.5,
  },
});
