/**
 * coach-screen.tsx — the Thread. Talk it through, then Nexus writes the plan.
 *
 * docs/plans/2026-09-02-coach-conversation.md. Everything decidable without
 * I/O lives in coach-thread.ts / coach-turn.ts / coach-opener.ts (vitest).
 * This screen owns: the model calls, voice in/out, the store writes (always
 * through setCoachThread), and the two surfaces it composes:
 *
 *   - CommandReviewCard for the plan (the same multi-action card the Command
 *     tab uses) and useCommandExecutor to write it: one write path, one tier
 *     gate, one undo (slice 0). Nothing here executes on tier alone.
 *   - CommandExecutionLedger for the location-bearing confirmation + undo.
 *
 * §22.7: hero = the latest coach line (the one Fraunces moment) until a plan
 * is on the table, when the card takes the hero slot and the composer is
 * demoted to a "Keep talking" link (one primary action, Law D). Motion: a
 * 250ms fade; nothing rises, so Reduce Motion has nothing to drop.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';
import { Audio } from 'expo-av';
import * as Speech from 'expo-speech';
import { getLocales } from 'expo-localization';
import { MotiView } from 'moti';
import tokens from '@/src/theme/tokens';
import { IconButton } from '@/src/components/ui/IconButton';
import { StatusBarScrim } from '@/src/components/ui/StatusBarScrim';
import { useAppState } from '@/src/state/app-state';
import { buildAIContext } from '@/src/utils/ai-context';
import { getLocalDateKey, validateProposedAction } from '@/src/utils/recurrence';
import { aiDiagnosticsOf, chatCompletion } from '@/src/utils/ai-client';
import { haptic } from '@/src/utils/haptics';
import { announce } from '@/src/utils/a11y';
import { addAppBreadcrumb } from '@/src/utils/breadcrumbs';
import * as Sentry from '@sentry/react-native';
import { useCommandExecutor } from '@/src/features/command/use-command-executor';
import { CommandReviewCard } from '@/src/features/command/command-review-card';
import { CommandExecutionLedger } from '@/src/features/command/command-execution-ledger';
import { useLiveTranscription } from '@/src/features/command/use-live-transcription';
import { useVoiceCaptureGuards } from '@/src/features/command/use-voice-capture-guards';
import { getProposalExecutionKey } from '@/src/features/command/command-executor';
import type { ProposedAction } from '@/src/features/command/command-types';
import {
  appendMessage,
  clearPendingPlan,
  clearThread,
  coachMessageId,
  dropStalePlanOnRestore,
  markPlanApplying,
  openerForDay,
  unmarkPlanApplying,
  setOpener,
  setPendingPlan,
  setSpeakReplies,
  type CoachMessage,
} from './coach-thread';
import {
  COACH_MODEL,
  SAFETY_HANDOFF_LINE,
  buildCoachContext,
  buildCoachMessages,
  classifySafety,
  classifyTurnError,
  coachResponseFormat,
  failedTurnLine,
  failureCode,
  parseCoachTurn,
} from './coach-turn';
import { OPENER_INSTRUCTION, prepareOpener, shouldAskModelForOpener } from './coach-opener';
import { COACH_SPEECH_RATE, pickCoachVoice } from './coach-voice';
import { synthesizeSpeech } from './coach-tts';
import { createCoachSpeaker } from './coach-speaker';

// Well past the Command tab's 15s: a coach turn carries a ~5k-char prompt,
// the week's context and up to 12 prior turns, and the reply can be a whole
// plan. Kimi's time-to-first-token on a prompt this size plus a cold proxy
// start blew a 25s budget on the first device run (build 255). The proxy's own
// upstream deadline is 60s (CHAT_UPSTREAM_TIMEOUT_MS), so 50s stays inside it.
const COACH_AI_TIMEOUT_MS = 50000;
const OPENER_AI_TIMEOUT_MS = 30000;
// A plan with four actions is ~600 tokens of JSON; bound the output so a
// runaway reply can neither truncate mid-JSON at a provider default nor run
// the clock out.
const COACH_MAX_TOKENS = 1400;

const WRITE_PLAN_TEXT = 'Write the plan with what you know so far.';

export function CoachScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const thread = useAppState((s) => s.coachThread);
  const setCoachThread = useAppState((s) => s.setCoachThread);
  const pausedNow = useAppState((s) => !!s.pauseMode?.active);
  const personalized = useAppState((s) => s.notificationSettings?.personalizedQuotes !== false);

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [failedLine, setFailedLine] = useState<string | null>(null);
  // The short reason under the retry line ("session-timeout", "http 401").
  // Law C in the other direction: a failure the person can read back is one
  // that can be fixed; builds 255/256 showed the same line for every cause.
  const [failedCode, setFailedCode] = useState<string | null>(null);
  const [needs, setNeeds] = useState<string[]>([]);
  const [composerShown, setComposerShown] = useState(true);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const openerReqRef = useRef(false);
  // Bumped by Clear conversation: a turn that resolves after a clear must not
  // append a lone reply to the empty thread.
  const generationRef = useRef(0);
  // Set on the first user turn after mount: an opener landing after it would
  // read as a non-sequitur reply, so it is skipped for the day.
  const userTurnSinceMountRef = useRef(false);
  const listeningRef = useRef(false);
  const pendingNeedsRef = useRef<string[]>([]);
  const scrollRef = useRef<ScrollView | null>(null);
  const inputRef = useRef<TextInput | null>(null);

  // One spoken clip at a time (coach-speaker.ts); the system voice is the
  // fallback when the proxy voice cannot be fetched.
  const speakerRef = useRef(createCoachSpeaker());
  const speakGenRef = useRef(0);
  const stopSpeaking = useCallback(() => {
    speakGenRef.current += 1;
    void Speech.stop();
    void speakerRef.current.stop();
  }, []);

  const liveTranscript = useLiveTranscription();
  const liveTranscriptRef = useRef(liveTranscript);
  liveTranscriptRef.current = liveTranscript;
  const guards = useVoiceCaptureGuards();

  const executor = useCommandExecutor({
    captureOrigin: 'coach',
    onExecuteSuccess: () => {
      scrollRef.current?.scrollToEnd({ animated: true });
    },
  });

  // ── lifecycle ────────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Never let a reply keep talking after the screen is gone (S1.8), and
      // never leave the recognizer armed: this is a pushed route and DOES
      // unmount (the Command tab never does). Read through refs, not the
      // first render's closure, and ratchet the audio session back.
      void Speech.stop();
      void speakerRef.current.stop();
      if (listeningRef.current) {
        listeningRef.current = false;
        void liveTranscriptRef.current.stop();
        void Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => {});
      }
    };
  }, []);

  // S2.5: a plan that was applying when the app died is not offered again;
  // the thread says where it went instead.
  useEffect(() => {
    const { dropped } = dropStalePlanOnRestore(useAppState.getState().coachThread);
    if (!dropped) return;
    setCoachThread((t) => {
      const next = dropStalePlanOnRestore(t).thread;
      const at = Date.now();
      return appendMessage(next, {
        id: coachMessageId(at),
        role: 'coach',
        text: 'That plan went to Home. Anything that did not land is one tap away there.',
        at,
        kind: 'note',
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const coachContext = useCallback(() => buildCoachContext({ ...buildAIContext(), pausedNow }), [pausedNow]);

  const appendCoach = useCallback(
    (text: string, kind: CoachMessage['kind'] = 'turn') => {
      const at = Date.now();
      setCoachThread((t) => appendMessage(t, { id: coachMessageId(at), role: 'coach', text, at, kind }));
    },
    [setCoachThread],
  );

  // S3.1 / S3.2 / S3.3: the first line of the day, once per day.
  useEffect(() => {
    const today = getLocalDateKey(new Date());
    const current = useAppState.getState().coachThread;
    if (openerForDay(current, today) || openerReqRef.current) return;
    if (pausedNow) return;
    openerReqRef.current = true;
    const generation = generationRef.current;
    const land = (candidate: string | null) => {
      // A clear while the request was in flight must not be repopulated.
      if (!mountedRef.current || userTurnSinceMountRef.current || generation !== generationRef.current) return;
      const opener = prepareOpener({ dayKey: today, pausedNow, personalized, candidate });
      if (!opener) return;
      setCoachThread((t) => {
        if (openerForDay(t, today)) return t;
        const at = Date.now();
        return appendMessage(setOpener(t, { ...opener, at }), { id: coachMessageId(at), role: 'coach', text: opener.text, at, kind: 'opener' });
      });
    };
    if (!shouldAskModelForOpener({ pausedNow, personalized })) {
      land(null);
      return;
    }
    void (async () => {
      try {
        const messages = buildCoachMessages({ context: coachContext(), thread: current, userText: OPENER_INSTRUCTION });
        const content = await chatCompletion(messages, {
          model: COACH_MODEL,
          response_format: coachResponseFormat(COACH_MODEL),
          timeoutMs: OPENER_AI_TIMEOUT_MS,
          max_tokens: 200,
        });
        const parsed = parseCoachTurn(content, { userText: OPENER_INSTRUCTION });
        if (parsed.kind === 'failed') addAppBreadcrumb('coach', 'opener_failed', { reason: parsed.reason });
        land(parsed.kind === 'reply' || parsed.kind === 'needs' || parsed.kind === 'plan' ? parsed.reply : null);
      } catch (err: unknown) {
        const c = classifyTurnError(err);
        addAppBreadcrumb('coach', 'opener_failed', { reason: c.kind, status: c.status });
        land(null);
      }
    })();
  }, [coachContext, pausedNow, personalized, setCoachThread]);

  // ── speech out ───────────────────────────────────────────────────────────
  // The best voice on this phone for the person's language (Enhanced or
  // Premium quality; see coach-voice.ts), resolved once. Until the list
  // arrives, or when nothing better exists, the OS default reads.
  const voiceRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    Speech.getAvailableVoicesAsync()
      .then((voices) => {
        if (!alive) return;
        const locale = getLocales()[0]?.languageTag || 'en-US';
        voiceRef.current = pickCoachVoice(voices, locale);
      })
      .catch(() => {
        // The OS default voice reads; nothing to surface.
      });
    return () => {
      alive = false;
    };
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!useAppState.getState().coachThread.speakReplies) return;
      // A reply never talks over the mic.
      if (listeningRef.current) return;
      stopSpeaking();
      const mine = speakGenRef.current;
      const fallback = () => {
        if (mine !== speakGenRef.current || !mountedRef.current || listeningRef.current) return;
        Speech.speak(text, {
          rate: COACH_SPEECH_RATE,
          ...(voiceRef.current ? { voice: voiceRef.current } : {}),
        });
      };
      void synthesizeSpeech(text)
        .then((clip) => {
          // Stopped, cleared, left, or the mic came on while the clip was fetched.
          if (mine !== speakGenRef.current || !mountedRef.current || listeningRef.current) return;
          addAppBreadcrumb('coach', 'tts_play', { ms: clip.ms, chars: text.length, provider: clip.provider });
          return speakerRef.current.play(clip.uri);
        })
        .catch((err: unknown) => {
          addAppBreadcrumb('coach', 'tts_fallback', { message: err instanceof Error ? err.message.slice(0, 80) : String(err) });
          fallback();
        });
    },
    [stopSpeaking],
  );

  // ── one turn ─────────────────────────────────────────────────────────────
  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || inFlightRef.current) return; // S1.7: a second send while one is in flight is ignored
      inFlightRef.current = true;
      userTurnSinceMountRef.current = true;
      const generation = generationRef.current;
      setPending(true);
      setFailedLine(null);
      setFailedCode(null);
      setRemoved(null);
      setDraft('');
      stopSpeaking();
      haptic('buttonPrimary');
      addAppBreadcrumb('coach', 'turn_sent');

      // The model is told what was still missing last turn (the thread's own
      // notes are not part of its context), while the thread stores the
      // person's words verbatim.
      const carried = pendingNeedsRef.current;
      const modelText = carried.length ? `${text}\n(Still needed for the plan: ${carried.join('; ')})` : text;

      const before = useAppState.getState().coachThread;
      const at = Date.now();
      setCoachThread((t) => appendMessage(t, { id: coachMessageId(at), role: 'user', text, at, kind: 'turn' }));

      try {
        // S1.3: deterministic safety pre-flight. The model is not called.
        const safety = classifySafety(text);
        if (safety.hit) {
          addAppBreadcrumb('coach', 'safety_handoff', { category: safety.category ?? 'unknown' });
          setCoachThread((t) => clearPendingPlan(t));
          setNeeds([]);
          appendCoach(SAFETY_HANDOFF_LINE, 'handoff');
          announce(SAFETY_HANDOFF_LINE);
          return;
        }

        const messages = buildCoachMessages({ context: coachContext(), thread: before, userText: modelText });
        const content = await chatCompletion(messages, {
          model: COACH_MODEL,
          response_format: coachResponseFormat(COACH_MODEL),
          timeoutMs: COACH_AI_TIMEOUT_MS,
          max_tokens: COACH_MAX_TOKENS,
        });
        if (!mountedRef.current || generation !== generationRef.current) return;
        const result = parseCoachTurn(content, { userText: text });
        switch (result.kind) {
          case 'failed': {
            // Law C: a failed turn is shown as failed (retry line), never as silence.
            addAppBreadcrumb('coach', 'turn_failed', { reason: result.reason });
            // The reply itself is never sent (it may hold the person's words);
            // the reason and length are enough to see a pattern.
            Sentry.captureMessage('coach turn failed to parse', {
              level: 'warning',
              tags: { surface: 'coach', reason: result.reason },
              extra: { contentLength: content.length, violations: result.violations ?? [] },
            });
            setFailedLine(failedTurnLine(result.reason));
            setFailedCode(failureCode(result.reason, { violations: result.violations }));
            haptic('voiceAmbiguous');
            break;
          }
          case 'reply': {
            setNeeds([]);
            pendingNeedsRef.current = [];
            appendCoach(result.reply);
            speak(result.reply);
            break;
          }
          case 'needs': {
            appendCoach(result.reply);
            setNeeds(result.needs);
            pendingNeedsRef.current = result.needs;
            speak(result.reply);
            break;
          }
          case 'plan': {
            setNeeds([]);
            pendingNeedsRef.current = [];
            appendCoach(result.reply);
            setCoachThread((t) => setPendingPlan(t, result.plan));
            setComposerShown(false);
            haptic('voiceSuccess');
            announce('A plan is ready. One tap adds it to your day.');
            speak(result.reply);
            break;
          }
          default:
            break;
        }
      } catch (err: unknown) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        const c = classifyTurnError(err);
        const diag = aiDiagnosticsOf(err) ?? { sessionFallback: false, sessionMs: -1 };
        addAppBreadcrumb('coach', 'turn_failed', { reason: c.kind, status: c.status, sessionMs: diag.sessionMs });
        // Every class is reported. Builds 255/256 skipped timeouts as "the
        // network's, not a defect" and the failing class (the session lookup
        // wedging before any request left the phone) was exactly the one no
        // report covered, so Sentry stayed empty while every turn failed.
        // Never the original error: chatCompletion's message carries the
        // first 200 chars of the provider body, which can echo the person's
        // words. A synthetic error with only the class and status is enough.
        Sentry.captureException(new Error(`coach turn ${c.kind}${c.status ? ` (${c.status})` : ''}`), {
          level: c.kind === 'offline' ? 'info' : 'warning',
          tags: { surface: 'coach', reason: c.kind },
          extra: { status: c.status, sessionMs: diag.sessionMs, sessionFallback: diag.sessionFallback },
        });
        setFailedLine(failedTurnLine(c.line));
        setFailedCode(failureCode(c.kind, { status: c.status }));
        haptic('voiceAmbiguous');
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setPending(false);
      }
    },
    [appendCoach, coachContext, setCoachThread, speak],
  );

  // ── voice in ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (listening) setDraft(liveTranscript.interimTranscript);
  }, [listening, liveTranscript.interimTranscript]);

  const toggleListening = useCallback(async () => {
    if (guards.isInFlight() || pending) return;
    setVoiceError(null);
    if (!listening) {
      setDraft('');
      // The mic never opens under a talking reply.
      stopSpeaking();
      const ok = await guards.lockWhile(() => liveTranscript.start({ continuous: true }));
      if (!guards.isMounted()) {
        if (ok) {
          void liveTranscript.stop();
          void Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => {});
        }
        return;
      }
      if (!ok) {
        setVoiceError('Microphone is off. Enable it in Settings, or type instead.');
        announce('Microphone is off. Enable it in Settings, or type instead.');
        return;
      }
      setListening(true);
      listeningRef.current = true;
      return;
    }
    await guards.lockWhile(async () => {
      await liveTranscript.stop();
      try {
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      } catch {
        // Non-fatal: quieter playback until the next setAudioMode call.
      }
      const final = (liveTranscript.finalTranscript || liveTranscript.getLastFinal() || liveTranscript.interimTranscript).trim();
      listeningRef.current = false;
      // The screen may have been left while stop() waited for its final
      // transcript: then nothing is sent and nothing is written.
      if (!mountedRef.current) return;
      setListening(false);
      liveTranscript.reset();
      if (final) {
        void send(final);
      } else {
        setDraft('');
        announce("I didn't catch that. Tap to try again.");
      }
    });
  }, [guards, listening, liveTranscript, pending, send]);

  // ── the plan ─────────────────────────────────────────────────────────────
  const pendingPlan = thread.pendingPlan;
  const planActions = useMemo(() => pendingPlan?.actions ?? [], [pendingPlan]);

  const applyPlan = useCallback(
    async (actions: ProposedAction[]) => {
      const plan = useAppState.getState().coachThread.pendingPlan;
      if (!plan || plan.applyingAt !== null || executor.isExecuting) return;
      // S2.5: stamp applying BEFORE the first write; drop only after the
      // executor returns. A kill in between leaves the stamp, never a
      // re-offer.
      setCoachThread((t) => markPlanApplying(t, Date.now()));
      const ran = await executor.executeActions(actions);
      if (!ran) {
        // The executor's lock or 3s dedupe bailed: nothing was written, so the
        // plan stays offered and the stamp comes off.
        setCoachThread((t) => unmarkPlanApplying(t));
        return;
      }
      if (!mountedRef.current) return;
      setCoachThread((t) => clearPendingPlan(t));
      setComposerShown(true);
      if (plan.hasCalendar) {
        appendCoach('On your Home. Calendar entries stay where they are; the rest can be undone below.', 'note');
      }
    },
    [appendCoach, executor, setCoachThread],
  );

  const editPlanAction = useCallback(
    (index: number, patch: Partial<ProposedAction>) => {
      setCoachThread((t) => {
        if (!t.pendingPlan) return t;
        const actions = t.pendingPlan.actions.map((a, i) => (i === index ? { ...a, ...patch } : a));
        return setPendingPlan(t, {
          ...t.pendingPlan,
          actions,
          proposalKey: getProposalExecutionKey(actions),
          hasCalendar: actions.some((a) => a.type === 'calendar_add'),
        });
      });
    },
    [setCoachThread],
  );

  const discardPlan = useCallback(() => {
    haptic('buttonSecondary');
    setCoachThread((t) => clearPendingPlan(t));
    setComposerShown(true);
  }, [setCoachThread]);

  // A removed row leaves the proposal; the last one removed ends it. Nothing
  // has been written yet, so there is no undo to owe.
  // Put back the last removed row (UF-01: a slip is recoverable). One level,
  // cleared by the next send, confirm, or cancel.
  const [removed, setRemoved] = useState<{ action: ProposedAction; index: number } | null>(null);
  const removePlanAction = useCallback(
    (index: number) => {
      let emptied = false;
      setCoachThread((t) => {
        if (!t.pendingPlan) return t;
        const gone = t.pendingPlan.actions[index];
        if (gone) setRemoved({ action: gone, index });
        const actions = t.pendingPlan.actions.filter((_, i) => i !== index);
        if (actions.length === 0) {
          emptied = true;
          return clearPendingPlan(t);
        }
        return setPendingPlan(t, {
          ...t.pendingPlan,
          actions,
          proposalKey: getProposalExecutionKey(actions),
          hasCalendar: actions.some((a) => a.type === 'calendar_add'),
        });
      });
      if (emptied) setComposerShown(true);
    },
    [setCoachThread],
  );

  const restoreRemoved = useCallback(() => {
    const r = removed;
    if (!r) return;
    haptic('buttonSecondary');
    setRemoved(null);
    setCoachThread((t) => {
      const current = t.pendingPlan?.actions ?? [];
      const actions = [...current.slice(0, r.index), r.action, ...current.slice(r.index)];
      const base = t.pendingPlan ?? { proposalKey: '', actions: [], hasCalendar: false, createdAt: Date.now(), applyingAt: null };
      return setPendingPlan(t, {
        ...base,
        actions,
        proposalKey: getProposalExecutionKey(actions),
        hasCalendar: actions.some((a) => a.type === 'calendar_add'),
        applyingAt: null,
      });
    });
    setComposerShown(false);
  }, [removed, setCoachThread]);

  // The card shows the executor's own validation per row, so a proposal the
  // model got wrong (a date that is not a date) cannot be confirmed as is.
  const planValidationErrors = useMemo(() => {
    const out: Record<number, string[]> = {};
    planActions.forEach((a, i) => {
      const v = validateProposedAction(a);
      if (!v.valid && v.errors.length) out[i] = v.errors;
    });
    return out;
  }, [planActions]);

  // ── clear / speech toggle ───────────────────────────────────────────────
  const confirmClear = useCallback(() => {
    Alert.alert('Clear this conversation', 'The thread is removed from this device and from the cloud on the next sync. Items already on your Home stay.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          generationRef.current += 1;
          stopSpeaking();
          setNeeds([]);
          pendingNeedsRef.current = [];
          setFailedLine(null);
          setComposerShown(true);
          setCoachThread((t) => clearThread(t, Date.now()));
          haptic('buttonSecondary');
          announce('Conversation cleared.');
        },
      },
    ]);
  }, [setCoachThread]);

  const toggleSpeak = useCallback(() => {
    // Mid-sentence, the speaker button is Stop; the preference stays on.
    if (speakerRef.current.isSpeaking()) {
      stopSpeaking();
      haptic('buttonSecondary');
      announce('Stopped.');
      return;
    }
    const on = !useAppState.getState().coachThread.speakReplies;
    if (!on) stopSpeaking();
    setCoachThread((t) => setSpeakReplies(t, on));
    haptic('buttonSecondary');
    announce(on ? 'Spoken replies on.' : 'Spoken replies off.');
  }, [setCoachThread, stopSpeaking]);

  // ── derived ──────────────────────────────────────────────────────────────
  // S3.1: under Pause Mode no opener is shown, including one stored earlier today.
  const messages = useMemo(
    () => (pausedNow ? thread.messages.filter((m) => m.kind !== 'opener') : thread.messages),
    [pausedNow, thread.messages],
  );
  const lastCoachId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === 'coach') return messages[i].id;
    return null;
  }, [messages]);
  const hasUserTurn = useMemo(() => messages.some((m) => m.role === 'user'), [messages]);
  const showCard = !!pendingPlan && pendingPlan.applyingAt === null;
  const canSend = draft.trim().length > 0 && !pending && !listening;

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length, showCard, needs.length, failedLine, executor.executionLedger]);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
        <View style={[styles.header, { paddingTop: insets.top > 0 ? tokens.spacing.xs : tokens.spacing.md }]}>
          <IconButton
            icon={<SymbolView name="chevron.left" size={tokens.icon.size.md} tintColor={tokens.color.text} weight={tokens.icon.weight.default} />}
            onPress={() => router.back()}
            size="md"
            accessibilityLabel="Back"
          />
          <Text style={styles.title}>Talk it through</Text>
          <IconButton
            icon={
              <SymbolView
                name={thread.speakReplies ? 'speaker.wave.2' : 'speaker.slash'}
                size={tokens.icon.size.md}
                tintColor={thread.speakReplies ? tokens.color.teal : tokens.color.textMuted}
                weight={tokens.icon.weight.default}
              />
            }
            onPress={toggleSpeak}
            size="md"
            variant="ghost"
            accessibilityLabel={thread.speakReplies ? 'Spoken replies on. Double tap to turn off' : 'Spoken replies off. Double tap to turn on'}
          />
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {messages.length === 0 && !pending ? (
            <Text style={styles.empty}>Say what is going on. One thing at a time is enough.</Text>
          ) : null}

          {messages.map((m) => {
            const isHero = !showCard && m.id === lastCoachId && m.kind !== 'note';
            if (m.role === 'user') {
              return (
                <View key={m.id} style={styles.userRow}>
                  <View style={styles.userBubble}>
                    <Text style={styles.userText}>{m.text}</Text>
                  </View>
                </View>
              );
            }
            return (
              <MotiView key={m.id} from={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ type: 'timing', duration: tokens.motion.standard.duration }} style={styles.coachRow}>
                <Text
                  style={[
                    isHero ? styles.coachHero : styles.coachText,
                    m.kind === 'note' ? styles.coachNote : null,
                    m.kind === 'handoff' ? styles.coachHandoff : null,
                  ]}
                  accessibilityRole="text"
                >
                  {m.text}
                </Text>
                {m.kind === 'note' ? (
                  <Pressable onPress={() => router.push('/(tabs)/home' as never)} hitSlop={16} accessibilityRole="button" accessibilityLabel="Open Home">
                    <Text style={styles.link}>OPEN HOME</Text>
                  </Pressable>
                ) : null}
              </MotiView>
            );
          })}

          {needs.length > 0 && !showCard ? (
            <View style={styles.needs}>
              <Text style={styles.needsLabel}>ONE MORE DETAIL</Text>
              {needs.map((n) => (
                <Text key={n} style={styles.needsLine}>
                  {n}
                </Text>
              ))}
            </View>
          ) : null}

          {failedLine ? (
            <Pressable onPress={() => { setFailedLine(null); setFailedCode(null); }} style={styles.failed} accessibilityRole="button" accessibilityLabel={`${failedLine} Double tap to dismiss`}>
              <Text style={styles.failedText}>{failedLine}</Text>
              {failedCode ? <Text style={styles.failedCode}>{failedCode}</Text> : null}
            </Pressable>
          ) : null}

          {showCard && pendingPlan ? (
            <MotiView from={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ type: 'timing', duration: tokens.motion.standard.duration }}>
              <CommandReviewCard
                proposedActions={planActions}
                validationErrors={planValidationErrors}
                onConfirm={(actions) => {
                  setRemoved(null);
                  void applyPlan(actions);
                }}
                onCancel={() => {
                  setRemoved(null);
                  discardPlan();
                }}
                onEditAction={editPlanAction}
                onRemoveAction={removePlanAction}
                isExecuting={executor.isExecuting}
              />
              {pendingPlan.hasCalendar ? <Text style={styles.calendarNote}>Calendar entries stay once added. Everything else can be undone.</Text> : null}
            </MotiView>
          ) : null}

          {removed ? (
            <Pressable onPress={restoreRemoved} style={styles.putBack} accessibilityRole="button" accessibilityLabel={`Put back ${removed.action.title}`}>
              <Text style={styles.putBackText}>Removed {removed.action.title}. <Text style={styles.putBackLink}>Put it back</Text></Text>
            </Pressable>
          ) : null}

          {executor.executionLedger ? (
            <CommandExecutionLedger
              ledger={executor.executionLedger}
              retryingLedgerKeys={executor.retryingLedgerKeys}
              onRetryItem={executor.onRetryItem}
              onUndoItem={executor.onUndoItem}
              onJumpItem={executor.onJumpItem}
              onAcceptTimeBlock={executor.onAcceptTimeBlock}
              onUndoTimeBlock={executor.onUndoTimeBlock}
              onAcceptBreakdown={executor.onAcceptBreakdown}
              onUndoBreakdown={executor.onUndoBreakdown}
              breakdownGrain={executor.breakdownGrain}
              onDismiss={executor.dismissLedger}
              autoDismissMs={0}
            />
          ) : null}
        </ScrollView>

        {/* The hairline brightens while a turn is in flight (§22.7 motion). */}
        <View style={[styles.hairline, { backgroundColor: pending ? tokens.color.luminousEdge : tokens.color.luminousEdgeSoft }]} />

        {showCard && !composerShown ? (
          <View style={styles.demoted}>
            <Pressable onPress={() => setComposerShown(true)} hitSlop={16} accessibilityRole="button" accessibilityLabel="Keep talking">
              <Text style={styles.link}>KEEP TALKING</Text>
            </Pressable>
          </View>
        ) : (
          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, tokens.spacing.sm) }]}>
            {voiceError ? <Text style={styles.voiceError}>{voiceError}</Text> : null}
            <View style={styles.composerRow}>
              <IconButton
                icon={
                  <SymbolView
                    name={listening ? 'stop.circle' : 'mic'}
                    size={tokens.icon.size.md}
                    tintColor={listening ? tokens.color.teal : tokens.color.textSecondary}
                    weight={tokens.icon.weight.default}
                  />
                }
                onPress={() => void toggleListening()}
                size="md"
                variant="ghost"
                disabled={pending}
                accessibilityLabel={listening ? 'Stop and send' : 'Speak'}
              />
              <TextInput
                ref={inputRef}
                value={draft}
                onChangeText={setDraft}
                placeholder={listening ? 'Listening' : 'Say what is going on'}
                placeholderTextColor={tokens.color.textDisabled}
                style={styles.input}
                multiline
                editable={!listening}
                returnKeyType="send"
                blurOnSubmit
                onSubmitEditing={() => void send(draft)}
                accessibilityLabel="Message"
              />
              <IconButton
                icon={<SymbolView name="arrow.up" size={tokens.icon.size.md} tintColor={canSend ? tokens.color.teal : tokens.color.textDisabled} weight={tokens.icon.weight.default} />}
                onPress={() => void send(draft)}
                size="md"
                variant="ghost"
                disabled={!canSend}
                accessibilityLabel="Send"
              />
            </View>
            <View style={styles.composerLinks}>
              {hasUserTurn && !showCard && !pending ? (
                <Pressable onPress={() => void send(WRITE_PLAN_TEXT)} hitSlop={16} accessibilityRole="button" accessibilityLabel="Write the plan now">
                  <Text style={styles.link}>WRITE THE PLAN</Text>
                </Pressable>
              ) : (
                <View />
              )}
              {messages.length > 0 ? (
                <Pressable onPress={confirmClear} hitSlop={16} accessibilityRole="button" accessibilityLabel="Clear conversation">
                  <Text style={styles.linkMuted}>CLEAR CONVERSATION</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
      <StatusBarScrim />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: tokens.spacing.sm,
    marginBottom: tokens.spacing.xs,
  },
  title: {
    ...tokens.type.titleScreen,
    color: tokens.color.text,
  },
  scroll: {
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.md,
    paddingBottom: tokens.spacing.lg,
    gap: tokens.spacing.md,
  },
  empty: {
    ...tokens.type.bodyMd,
    color: tokens.color.textMuted,
    textAlign: 'center',
    marginTop: tokens.spacing.xl,
  },
  userRow: { alignItems: 'flex-end' },
  userBubble: {
    maxWidth: '84%',
    backgroundColor: tokens.color.surfaceElevated,
    borderRadius: tokens.radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.color.luminousEdgeSoft,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  userText: {
    ...tokens.type.bodyMd,
    color: tokens.color.textSecondary,
  },
  coachRow: { alignItems: 'flex-start', gap: tokens.spacing.xs },
  coachHero: {
    ...tokens.type.poeticMd,
    color: tokens.color.text,
  },
  coachText: {
    ...tokens.type.bodyMd,
    color: tokens.color.text,
  },
  coachNote: {
    color: tokens.color.textMuted,
  },
  coachHandoff: {
    color: tokens.color.teal,
  },
  needs: {
    gap: tokens.spacing.xs,
  },
  needsLabel: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textMuted,
  },
  needsLine: {
    ...tokens.type.caption,
    color: tokens.color.textSecondary,
  },
  failed: {
    paddingVertical: tokens.spacing.xs,
  },
  failedText: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
  },
  failedCode: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
    fontFamily: tokens.font.plexMonoRegular,
    marginTop: tokens.spacing.xs,
  },
  putBack: {
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: tokens.spacing.xs,
  },
  putBackText: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
  },
  putBackLink: {
    color: tokens.color.teal,
  },
  calendarNote: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
    marginTop: tokens.spacing.xs,
  },
  hairline: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: tokens.spacing.lg,
  },
  demoted: {
    alignItems: 'center',
    paddingVertical: tokens.spacing.md,
  },
  composer: {
    paddingHorizontal: tokens.spacing.sm,
    paddingTop: tokens.spacing.xs,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: tokens.spacing.xs,
  },
  input: {
    ...tokens.type.bodyMd,
    color: tokens.color.text,
    flex: 1,
    maxHeight: tokens.spacing.xxl * 3,
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.sm,
  },
  composerLinks: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: tokens.spacing.sm,
    paddingTop: tokens.spacing.xs,
  },
  link: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.teal,
  },
  linkMuted: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textMuted,
  },
  voiceError: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
    paddingHorizontal: tokens.spacing.sm,
  },
});

export default CoachScreen;
