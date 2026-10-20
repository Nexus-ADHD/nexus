// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  AppState,
  AccessibilityInfo,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAppState } from '../../src/state/app-state';
import { useShallow } from 'zustand/react/shallow';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import tokens from '../../src/theme/tokens';
import { useBreakpoints } from '../../src/theme/layout';
import { haptic } from '../../src/utils/haptics';
import { AnimatePresence } from 'moti';
import { StructuredStart } from '../../src/features/command/structured-start';
import { transcribeAudio, chatCompletion, AiTimeoutError, SessionTimeoutError, MIN_FETCH_BUDGET_MS } from '../../src/utils/ai-client';
import { MODELS } from '../../src/utils/ai-models';
import { useLiveTranscription } from '../../src/features/command/use-live-transcription';
import { CommandWaveform, useCadenceWaveform } from '../../src/features/command/CommandWaveform';
import { shouldShowWaveform } from '../../src/features/command/waveform-model';
import { useVoiceCaptureGuards } from '../../src/features/command/use-voice-capture-guards';
import { announce } from '../../src/utils/a11y';
import { addAppBreadcrumb } from '../../src/utils/breadcrumbs';
import { validateProposedAction, normalizeProposedAction } from '../../src/utils/recurrence';
import { ProposedAction } from '../../src/features/command/command-types';
import { COMMAND_EXAMPLES } from '../../src/features/command/command-examples';
import { parseAIResponse, coerceAction, buildTranscriptInboxAction } from '../../src/features/command/command-parser';
import { parseCaptureGrammar, CAPTURE_FRAMING_PREFIXES } from '../../src/features/command/grammar-parser';
import { COMMAND_ACTIONS_JSON_SCHEMA } from '../../src/features/command/command-schema';
import { buildCommandResponseFormat, isSchemaValidation400, fallbackBudgetMs } from '../../src/features/command/structured-output';
import { CommandExecutionLedger } from '../../src/features/command/command-execution-ledger';
import { CommandClarification } from '../../src/features/command/command-clarification';
import { CommandPreviewCard } from '../../src/features/command/command-preview-card';
import { projectCommandPreview, applyPreviewDate, CommandPreview } from '../../src/features/command/command-preview';
import { CommandLowTier } from '../../src/features/command/command-low-tier';
import {
  resolveCaptureTier,
  inboxFallback,
  Clarification,
  ClarificationChip,
} from '../../src/features/command/confidence-tier';
import { useCommandExecutor } from '../../src/features/command/use-command-executor';
import { ambientGlowSoft } from '../../src/theme/glow';
import { VoiceOrb } from '../../components/VoiceOrb';
import { LinearGradient } from 'expo-linear-gradient';

// FIXME(nex-56): tokens.color.textDisabled off-scale gray for TextInput placeholders, no token — design review
const PLACEHOLDER_COLOR = tokens.color.textDisabled;

// NEX-280: hard deadline on the capture AI call. Covers the auth-session
// lookup AND the network phase (see ChatOptions.timeoutMs). On timeout the
// capture falls to the low-tier retry UI instead of stranding isProcessing
// forever — a hung promise here used to brick the orb (the tap guard keys on
// isProcessing) until the user force-restarted the app.
const COMMAND_AI_TIMEOUT_MS = 15000;

// NEX-280: low-tier sentinel for "nothing heard". Must be TRUTHY — the render
// gates key on `lowTierText` truthiness — while trimming to empty so
// CommandLowTier hides its quote block and shows only "I DIDN'T CATCH THAT"
// + the retry affordance. Never round-trips into a parse (retryLowTier and
// dismissCapture both discard the text).
const EMPTY_CAPTURE_SENTINEL = ' ';

// The "I DIDN'T CATCH THAT" card is deliberately generic (Law C: no scold, no
// alarm) for five distinct causes — silence, a low-confidence AI parse, a
// malformed AI response, an AI-proxy rejection, or a timeout. That's the
// right UX, but it made every prior report of this card undiagnosable: no
// signal recorded which cause fired. This classifies the cause for a
// breadcrumb only — never the transcript or raw error text (crash-telemetry
// no-PII rule) — so a recurrence can be told apart from "stale build" vs a
// live proxy/timeout issue.
type LowTierReason =
  | 'empty_transcript'
  | 'low_confidence'
  | 'parse_failure'
  | 'ai_request_failed'
  | 'timeout'
  | 'session_timeout';

// Single source of truth for the three parseAIResponse/chatCompletion throw
// messages that count as a parse failure — also read by the isParseFailure
// gate below so the two can't drift apart.
const PARSE_FAILURE_MESSAGES = [
  'AI returned invalid JSON.',
  'AI response missing valid actions array.',
  'AI response content missing.',
] as const;

// Only call this once isParseFailure || isTimeout || isAiRequestFailure has
// already been confirmed true (the sole call site below does this) — an
// error that matches none of those falls through to 'ai_request_failed' with
// no status, which would mis-tag an unrelated error if this were ever called
// from a new, ungated site.
function classifyLowTierReason(err: unknown): { reason: LowTierReason; status?: number } {
  if (err instanceof AiTimeoutError) return { reason: 'timeout' };
  if (err instanceof SessionTimeoutError) return { reason: 'session_timeout' };
  const message = err instanceof Error ? err.message : '';
  if ((PARSE_FAILURE_MESSAGES as readonly string[]).includes(message)) {
    return { reason: 'parse_failure' };
  }
  const statusMatch = message.match(/^AI request failed \((\d+)\)/);
  return { reason: 'ai_request_failed', status: statusMatch ? Number(statusMatch[1]) : undefined };
}

export default function CommandScreen() {
  const { capacity, setNightlyForward } = useAppState(
    useShallow((s: any) => ({ capacity: s.capacity, setNightlyForward: s.setNightlyForward })),
  );
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // Adaptive layout (Phase 1 iPad support): the Command tab stays full-bleed
  // (VoiceOrb + gradient overlays are absolute, by design) — only the content
  // region (prompt / ledgers / input) is constrained to the centered column.
  const { isWide, contentMaxWidth } = useBreakpoints();
  // Orb's vertical anchor. Sits ~80pt below the safe area top so the
  // orb is the first thing the user sees when the Command tab opens.
  // The previous 45%-of-visible-viewport rule pushed the orb a full
  // screen-height down, hiding it under the fold until the user
  // scrolled. The orb is the hero — it has to be visible immediately.
  const orbPaddingTop = insets.top + 80;
  const liveTranscript = useLiveTranscription();
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  // Local UI state for the VoiceOrb. Tracks idle/listening; bound to
  // useLiveTranscription via the press handler below.
  const [orbState, setOrbState] = useState<'idle' | 'listening'>('idle');
  // NEX-316: Reduce Motion gates the listening waveform back to the words. The
  // value is only ever trusted when it has been CONFIRMED by a live async read —
  // there is no reliable synchronous source (reanimated's useReducedMotion is a
  // static app-start snapshot that never updates and goes stale the moment the
  // user toggles the setting). So the trace is suppressed until confirmed:
  //   - rmStale starts TRUE and is cleared only when an async read resolves, so
  //     no snapshot or stale value can ever enable the waveform.
  //   - reduceMotionChanged updates the value on a RUNTIME toggle (foreground).
  //   - the change event is NOT delivered while backgrounded, so we mark the
  //     value unconfirmed and re-read on AppState 'active'.
  // During any unconfirmed window the words show — the accessible fallback wins
  // whenever we cannot prove Reduce Motion is off (§1.5 UF-01).
  const [reduceMotion, setReduceMotion] = useState(false);
  const [rmStale, setRmStale] = useState(true);
  const rmReqRef = useRef(0);
  useEffect(() => {
    let mounted = true;
    // A monotonic request id guards the async reads: only the most recent one
    // applies, and a synchronous change event bumps the id so any in-flight
    // read is invalidated and cannot clobber the fresher event value.
    const refresh = () => {
      const id = ++rmReqRef.current;
      AccessibilityInfo.isReduceMotionEnabled()
        .then((v) => {
          if (mounted && id === rmReqRef.current) {
            setReduceMotion(!!v);
            setRmStale(false);
          }
        })
        .catch(() => {
          // A failed read is NOT a confirmation: leave rmStale true so the
          // words (the accessible fallback) keep showing. It self-heals on the
          // next successful read (foreground) or a reduceMotionChanged event.
        });
    };
    // Mount: the value is unconfirmed (rmStale starts true) until this resolves.
    refresh();
    const changeSub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => {
      rmReqRef.current += 1; // an event is authoritative; drop any pending read
      setReduceMotion(!!v);
      setRmStale(false);
    });
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        // The setting may have changed while backgrounded (the change event is
        // not delivered then), so the value is unconfirmed until the re-read lands.
        setRmStale(true);
        refresh();
      }
    });
    return () => {
      mounted = false;
      changeSub?.remove?.();
      appSub?.remove?.();
    };
  }, []);
  // NEX-316: the waveform REPLACES "I'm listening." while the recognizer is
  // actually running (the safe cadence source). If recognition never started
  // (simulator, permission denied) or Reduce Motion is on, the words stay —
  // the swap contract lives in waveform-model.ts.
  const showWaveform = shouldShowWaveform({
    listening: orbState === 'listening',
    meteringAvailable: liveTranscript.isRecognizing,
    // Treat an unconfirmed (stale) reading as reduce-motion so the words win
    // until we can prove otherwise.
    reduceMotion: reduceMotion || rmStale,
  });
  // interimTranscript is ALREADY the full accumulated transcript-so-far while
  // speaking (see use-live-transcription), so it is the single monotonic cadence
  // source. Concatenating finalTranscript + interimTranscript would double-count
  // every committed segment and spike the trace to full amplitude at each
  // finalization boundary.
  const waveHeights = useCadenceWaveform(
    showWaveform,
    liveTranscript.interimTranscript || liveTranscript.finalTranscript || '',
  );
  // Surfaced under the input when start() fails (most commonly mic
  // permission denied). Cleared on the next press.
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // Tracks iOS keyboard height so the absolutely-positioned bottom
  // overlay (prompt + input + proposal panel) can lift above the keyboard.
  // KeyboardAvoidingView's `padding` behavior doesn't reliably reposition
  // position:absolute children inside a tab navigator, so we drive the
  // offset manually. iOS-only listener events (keyboardWillShow/Hide)
  // give us the height pre-animation; Android falls back to keyboardDidShow.
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setKeyboardOffset(e?.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardOffset(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // While listening, mirror the recognizer's live transcript into the
  // input field so the user sees their words land in real time. After
  // stop() the press handler writes the final transcript directly,
  // so manual edits made after stopping aren't clobbered.
  useEffect(() => {
    if (orbState !== 'listening') return;
    const live = liveTranscript.finalTranscript || liveTranscript.interimTranscript;
    if (live) setManualCommand(live);
  }, [liveTranscript.interimTranscript, liveTranscript.finalTranscript, orbState]);

  // Shared re-entrancy + lifecycle guard (NEX-193 / NEXUS-5). Owns the
  // in-flight lock (so a fast double-tap can't double-activate the session) and
  // the mountedRef (so a start() resolving after unmount tears down cleanly).
  // This screen has no extra unmount teardown beyond mounted=false (the
  // recognizer is stopped by the AppState background listener and the
  // post-start guard below), so no onUnmount callback is passed.
  const guards = useVoiceCaptureGuards();

  const handleVoiceOrbPress = async () => {
    // App-Hang repro path breadcrumb (no PII — state only).
    addAppBreadcrumb('command', 'orb_pressed', { orbState });
    if (showCommandTip) dismissCommandTip();
    setVoiceError(null);
    // The manual input has no other dismiss affordance, so if the keyboard is
    // up the first orb tap just blurs/dismisses it (the orb fills the screen,
    // so this doubles as tap-anywhere-to-dismiss) — without this guard, tapping
    // the orb to put the keyboard away would unexpectedly start recording.
    if (keyboardOffset > 0) {
      manualInputRef.current?.blur();
      Keyboard.dismiss();
      return;
    }
    // Re-entrancy guard (NEXUS-5): one start/stop in flight at a time, so the
    // orb tap can never double-activate the session.
    if (guards.isInFlight()) return;
    // Fail fast: don't begin a new voice capture while a previous command is
    // still parsing/executing — capture must not overlap proposal execution.
    if (orbState === 'idle' && (isProcessing || isExecuting)) return;
    if (orbState === 'idle') {
      // Reset the input so live transcript replaces rather than appends.
      setManualCommand('');
      const ok = await guards.lockWhile(() => liveTranscript.start({ continuous: true }));
      if (!guards.isMounted()) {
        // Unmounted while start() was in flight — tear the recognizer down AND
        // ratchet the audio session back to playback (issue #72), which the
        // normal stop branch does but this teardown would otherwise skip.
        if (ok) {
          void liveTranscript.stop();
          void Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => {});
        }
        return;
      }
      if (!ok) {
        // Fail fast: surface the error; orbState was never flipped, so nothing
        // to revert and the live-transcript mirror never ran (no stray text).
        setVoiceError('Microphone access denied. Enable it in Settings to use voice.');
        announce('Microphone is off. Enable it in Settings, or type your command instead.');
        return;
      }
      // Flip to 'listening' only after the recognizer is actually armed, so the
      // Eye never shows listening on a failed start and the mirror effect can't
      // copy a prior session's transcript into the input.
      setOrbState('listening');
      addAppBreadcrumb('command', 'listening_started');
    } else {
      await guards.lockWhile(async () => {
        await liveTranscript.stop();
        // Ratchet the audio session back to playback so the recognizer's record
        // mode doesn't dampen subsequent app audio (issue #72). The Whisper path
        // does the same in its finally; the live path must too.
        try {
          await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
        } catch {
          // Non-fatal — quieter playback until the next setAudioMode call.
        }
        // Belt-and-suspenders: capture the last final in case the effect
        // hasn't fired between the last event and stop(). Trimmed — a
        // whitespace-only transcript would pass a truthiness check and then
        // die silently in generateProposal's own empty-text early return.
        const final = (
          liveTranscript.finalTranscript ||
          liveTranscript.getLastFinal() ||
          liveTranscript.interimTranscript
        ).trim();
        if (final) {
          setManualCommand('');
          captureOriginRef.current = 'voice';
          void generateProposal(final);
        } else {
          // NEX-280: an empty transcript was a silent no-op — the orb went
          // idle with zero feedback ("it just doesn't process"). Surface the
          // same low-tier retry UI parse failures use (§18 / Law C: no scold,
          // no alert). Clear the input too — the live mirror can leave stale
          // interim text behind, and dismissCapture doesn't clear it. Like
          // every other capture entry point, a new capture replaces any
          // pending clarification/ledger — otherwise a mid-question empty
          // stop renders BOTH the question card and the low-tier card.
          setManualCommand('');
          setClarification(null);
          dismissLedger();
          captureOriginRef.current = 'voice';
          haptic('voiceAmbiguous');
          addAppBreadcrumb('command', 'low_tier_shown', { reason: 'empty_transcript' });
          setLowTierText(EMPTY_CAPTURE_SENTINEL);
          announce("I didn't catch that. Tap to try again.");
        }
        setOrbState('idle');
      });
    }
  };
  const [showStructuredStart, setShowStructuredStart] = useState(false); // NEX-260 (L-5)
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDebriefing, setIsDebriefing] = useState(false);
  const [manualCommand, setManualCommand] = useState('');
  // NEX-197: confidence-tiered capture replaces the pre-save proposal form.
  // medium → a single scoped chip question; low → verbatim transcript + retry.
  const [clarification, setClarification] = useState<{ actions: ProposedAction[]; clarification: Clarification } | null>(null);
  const [lowTierText, setLowTierText] = useState<string | null>(null);
  // Whether the just-parsed capture came from voice or the typed input —
  // decides how "Tap to try again" re-arms (re-record vs refocus the field).
  const captureOriginRef = React.useRef<'voice' | 'typed'>('typed');
  // NEX-280: run-generation counter. The typed submit and the voice stop path
  // aren't gated on isProcessing, so two generateProposal runs CAN overlap; a
  // run that is no longer the newest must never execute actions or mutate UI.
  const proposalRunRef = React.useRef(0);

  const [pendingApiKey, setPendingApiKey] = useState('');
  const [showCommandTip, setShowCommandTip] = useState(false);
  // NEX-166: whether the user has completed their first successful command.
  // Gates the inline "still learning" nudge (the recall link persists either way).
  const [firstCommandDone, setFirstCommandDone] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const justAddedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const manualInputRef = useRef<TextInput | null>(null);
  // NEX-318 (Phase 2): live-preview state + a generation ref so a stale debounced
  // parse can never set the preview after a newer keystroke.
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const previewGenRef = useRef(0);

  // Execution controller (docs/typescript-hardening.md rule #3): the tier-
  // resolved action list is written, confirmed and undone in
  // use-command-executor.ts, shared with the coach thread. This screen keeps
  // how a capture reaches it (voice, typed, preview, clarification chip) and
  // its own success chrome.
  const {
    executionLedger,
    isExecuting,
    retryingLedgerKeys,
    // NEX-210: remembered breakdown grain, primary chip on the "break into steps" offer.
    breakdownGrain,
    executeActions,
    dismissLedger,
    onRetryItem: retryExecutionLedgerItem,
    onUndoItem: handleUndoLedgerItem,
    onJumpItem: handleJumpLedgerItem,
    onAcceptTimeBlock: handleAcceptLedgerTimeBlock,
    onUndoTimeBlock: handleUndoLedgerTimeBlock,
    onAcceptBreakdown: handleAcceptLedgerBreakdown,
    onUndoBreakdown: handleUndoLedgerBreakdown,
  } = useCommandExecutor({
    captureOrigin: 'command',
    onExecuteStart: () => {
      setClarification(null);
      setLowTierText(null);
    },
    onExecuteSuccess: () => {
      // NEX-166: first fully-successful command (typed or voice) retires the
      // first-run example guidance for good. Device-level flag.
      if (!firstCommandDone) {
        setFirstCommandDone(true);
        AsyncStorage.setItem('nexus_firstCommandDone', 'true').catch(() => {});
      }
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      setJustAdded(true);
      if (justAddedTimerRef.current) clearTimeout(justAddedTimerRef.current);
      justAddedTimerRef.current = setTimeout(() => setJustAdded(false), 1200);
    },
  });
  useEffect(() => () => {
    if (justAddedTimerRef.current) clearTimeout(justAddedTimerRef.current);
  }, []);

  useEffect(() => {
    AsyncStorage.getItem('nexus_hasSeenCommandTip').then(val => {
      if (!val) setShowCommandTip(true);
    }).catch(() => {});
  }, []);

  // NEX-166: device-level flag (parallel to nexus_hasSeenCommandTip). Read once
  // on mount; set in the command success path below.
  useEffect(() => {
    AsyncStorage.getItem('nexus_firstCommandDone').then(val => {
      if (val) setFirstCommandDone(true);
    }).catch(() => {});
  }, []);

  const dismissCommandTip = () => {
    setShowCommandTip(false);
    AsyncStorage.setItem('nexus_hasSeenCommandTip', 'true').catch(() => {});
  };

  const generateProposal = async (rawText: string) => {
    const text = rawText.trim();
    if (!text) return;

    // NEX-280: claim the run AFTER the empty-text early return — an early
    // return has no finally, so incrementing above it would mark the in-flight
    // run stale, skip its cleanup, and strand isProcessing=true (the exact
    // lockout this ticket fixes). From here on, the newest run's finally
    // always runs and always clears.
    const runId = ++proposalRunRef.current;
    const isStale = () => proposalRunRef.current !== runId;

    setIsProcessing(true);
    // App-Hang repro path breadcrumb (no PII — never the transcript text).
    addAppBreadcrumb('command', 'processing_started');
    setClarification(null);
    setLowTierText(null);
    dismissLedger();
    haptic('buttonPrimary');
    // §9.6: announce processing for screen-reader users (covers both the voice
    // path and the typed path, which both route through here). Fires once.
    announce('Processing your command.');

    try {
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const tomorrowDate = new Date(now); tomorrowDate.setDate(now.getDate() + 1);
      const tomorrowStr = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getDate()).padStart(2, '0')}`;

      // Tier-1 deterministic offline grammar (NEX-223 / CLAUDE.md §14.1). A
      // confident match short-circuits the AI proxy below; null falls through.
      const grammarActions = parseCaptureGrammar(text, now);
      let normalizedActions: ProposedAction[];

      const liveState: any = useAppState.getState?.() ?? {};
      const userPillars = Array.isArray(liveState.pillars)
        ? liveState.pillars.map((p: any) => p.title).slice(0, 8).join(', ')
        : '';
      const userRecurring = Array.isArray(liveState.recurringRules)
        ? liveState.recurringRules.map((r: any) => r.title).slice(0, 8).join(', ')
        : '';
      const userInbox = Array.isArray(liveState.inbox)
        ? liveState.inbox.filter((t: any) => !t.completed && t.status !== 'ARCHIVED').map((t: any) => t.title).slice(0, 5).join(', ')
        : '';
      const userName = liveState.userProfile?.name ?? '';
      const userAnchor = liveState.userProfile?.anchor ?? '';
      const userVision = liveState.userProfile?.vision ?? '';

      const contextBlock = [
        userName ? `User name: ${userName}` : '',
        userAnchor ? `User's anchor: ${userAnchor}` : '',
        userVision ? `User's vision: ${userVision}` : '',
        userPillars ? `Current goals/pillars: ${userPillars}` : '',
        userRecurring ? `Existing recurring habits/blocks: ${userRecurring}` : '',
        userInbox ? `Current inbox items: ${userInbox}` : '',
      ].filter(Boolean).join('\n');

      const systemPrompt = `
You are an elite Chief of Staff AI and personal operating system. You know this user deeply and take decisive action on their behalf.
Today's date is ${todayStr}. Tomorrow is ${tomorrowStr}. The current time is ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}.

${contextBlock ? `USER CONTEXT:\n${contextBlock}\n` : ''}
ACTIONS ALLOWED:
- "calendar_add" — a scheduled EVENT with duration (meeting, appointment, class, scheduled block). One-off by default. A TIMED RECURRING block (a recurring cadence WITH a clock time) is a repeating calendar event — add a "recurrence" object (see CALENDAR RECURRENCE below).
- "inbox_add" — vague capture, brain dump, or unclear intent for triage. NEVER include a date or time on inbox_add — these go into Inbox without scheduling. If the user mentions ANY date/time reference, route to todo_add or calendar_add instead — UNLESS the EXPLICIT INBOX OVERRIDE below applies (the user named the inbox as the destination), in which case every listed item is inbox_add regardless of any time words.
- "align" — a goal, pillar, or strategic priority. Include a "category" field: one of "BUSINESS", "VISION", or "PERSONAL". Infer the category from context — e.g. "own property internationally" or "travel" or "creative" = VISION, "sales", "revenue", "brand", "work" = BUSINESS, "family", "health", "spiritual", "fitness" = PERSONAL. Default to BUSINESS only if truly unclear.
- "recurring_add" — a HABIT or recurring routine (identity-building behavior). Include daysOfWeek and EITHER a clock time/preferredTimeBlock OR a timesPerDay frequency (>=1).
- "todo_add" — a one-off action item on a date (with optional clock time as a soft due hint, not a meeting)
- "recurring_todo_add" — a recurring CHORE / errand / admin task that is NOT identity-building (e.g. "take out the trash every Sunday", "submit timesheet every Friday"). Schema: { title, daysOfWeek: number[], interval?: number }. interval=1 is weekly (default); interval=2 is biweekly ("every other X" / "every two weeks"); interval=3 is every three weeks; etc. Use interval ONLY when the user explicitly says biweekly / every-other / every-N-weeks.

EXPLICIT CALENDAR OVERRIDE — read this first:
- If the user EXPLICITLY references the calendar — "add to my calendar", "put it on my calendar", "throw it on my calendar", "block on my calendar", "schedule on my calendar", "add a calendar event/block/invite", "put on the calendar" — they want a calendar event, not a habit. MUST emit "calendar_add". Default duration: use the user's stated duration if given ("for 20 minutes" → 20-minute block), otherwise 1 hour.
- If a recurring cadence is present ("daily", "every day", "every weekday", "every Sunday", etc.), attach a "recurrence" object so the event REPEATS (see CALENDAR RECURRENCE) and set startISO/endISO to the NEXT matching occurrence. With no cadence, emit a single one-off calendar_add (no recurrence) for the next applicable day at the stated time (today if the time hasn't passed, otherwise tomorrow).
- This override beats the HABIT routing below. The word "habit" still beats this override (route to recurring_add, Rule 16 below).

EXPLICIT INBOX OVERRIDE — read this second:
- If the user EXPLICITLY names the inbox as the destination — "add to my inbox", "put in my inbox", "save to my inbox", "inbox this", "inbox these", "brain dump", "capture these" — they want every listed item captured to Inbox for later triage. MUST emit one "inbox_add" per listed item, "confidence": "high". Split a comma-separated or "and"-joined list into SEPARATE inbox_add actions.
- Under this override, DROP any date/time framing from each item and emit NO dateStr/time/startISO — the user chose the inbox, not the schedule. (This is the one case where an item mentioning a time still becomes inbox_add.)
- Precedence: the EXPLICIT CALENDAR OVERRIDE still wins for an item that also names the calendar; this inbox override governs everything else the user routed to the inbox, and beats the todo/habit routing below.

TIMED RECURRING BLOCK — choose this FIRST among the recurring types:
- A recurring cadence WITH an explicit CLOCK TIME (e.g. "every Sunday at 10am", "every weekday at 6am", "daily at 9pm") is a repeating CALENDAR EVENT → emit "calendar_add" with a "recurrence" object (see CALENDAR RECURRENCE), NOT a habit and NOT a recurring to-do. This holds even for identity words like "workout" or "run" — a timed block lives on the calendar.
- The word "habit" still overrides this → "recurring_add" (the user explicitly asked for a habit).

HABIT vs RECURRING-TODO — for recurring intent with NO clock time:
- If the user says the word "habit" -> emit "recurring_add" — UNLESS the wording is about STOPPING a behavior ("quit", "stop", "break the habit", "kick the habit", "cut down/back", "reduce", "give up", "bad habit", "no more"). Cessation is not a new daily rep, so route those to "inbox_add" for the user to shape (never auto-create a recurring habit that fires every day).
- If the user describes an identity-building behavior with a cadence and NO clock time (a daypart like "every morning" / a frequency like "twice a day") — meditation, mantras, prayer, journaling, reading, workouts, stretching, gratitude, language practice, breathwork, cold plunge, supplements, water intake — -> "recurring_add".
- Frequency phrases that imply a habit (no clock time): "every morning", "every night", "twice a day", "X times a day", "X times a week", "daily", "every day".
- Only use "recurring_todo_add" for untimed chores/errands/admin work that is not identity-building.

HABIT SCHEMA (for "recurring_add"):
- "daysOfWeek": required. Default to [0,1,2,3,4,5,6] when the user says "every day", "daily", "every morning/night", or "X times a day" without specifying days.
- "timesPerDay": integer >= 1. Default 1. Set to 2 for "twice a day", 3 for "three times a day", etc. Cap at 12.
- "time": optional 24-hour clock string ("17:00") if user named a specific time.
- "preferredTimeBlock": optional one of "morning" | "afternoon" | "evening" | "night" if the user said "every morning" / "every evening" etc. without a clock time.
- A habit is valid if it has daysOfWeek AND (timesPerDay>=1 OR time OR preferredTimeBlock).

CALENDAR RECURRENCE (for a repeating "calendar_add" — a recurring cadence WITH a clock time):
- Add a "recurrence" object: { "frequency": "daily" | "weekly", "interval"?: number, "daysOfWeek"?: number[] }.
- "every Sunday" → weekly, daysOfWeek [0]. "every weekday" → weekly [1,2,3,4,5]. "every weekend" → weekly [0,6]. "every day"/"daily" → daily (omit daysOfWeek). "every other Friday" → weekly [5], interval 2. interval defaults to 1; set it only for "every other"/"every N weeks".
- ALWAYS set startISO/endISO to the NEXT matching occurrence (the first day the block should fire, in local time). The event then repeats per "recurrence".
- Attach "recurrence" ONLY when the user expressed a recurring cadence. A one-off event omits "recurrence" entirely.

CRITICAL RULES:
1. Every action MUST use one of the allowed action types.
2. "calendar_add" requires startISO and endISO as full ISO 8601 strings (e.g. "2026-03-26T19:00:00"). Default event duration is 1 hour if not specified.
3. ROUTING by clock + cadence: a recurring cadence WITH a clock time → "calendar_add" with a "recurrence" object (a repeating timed calendar event). A recurring cadence with NO clock time → "recurring_add" (identity habit) or "recurring_todo_add" (untimed chore). The word "habit" always → "recurring_add". A one-off timed event → "calendar_add" with no recurrence.
4. JS weekday indexing: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.
5. "every day" = daysOfWeek [0,1,2,3,4,5,6]. "weekdays" = [1,2,3,4,5]. "weekends" = [0,6].
6. "todo_add" requires dateStr as YYYY-MM-DD. Optionally include "time" as a 24-hour HH:mm string for a soft due time (e.g. "remind me at 3pm" → time: "15:00"). Resolve relative dates: "tonight"="${todayStr}", "today"="${todayStr}", "tomorrow"="${tomorrowStr}". For day names, calculate the next upcoming occurrence.
7. Use "todo_add" for action items even if a clock time is given — phone calls, errands, personal tasks. Use "calendar_add" ONLY for events with duration: meetings, appointments, classes, scheduled blocks. When in doubt between todo_add and calendar_add, prefer todo_add. For "remind me to" phrasing, see Rule 16 for routing.
7a. Use "inbox_add" for vague, emotional, or unclear captures (no clear action verb, no date).
8. If recurrence days are ambiguous, return daysOfWeek:[] and missingFields:["daysOfWeek"].
9. Use 24-hour time strings: "17:00".
10. Use user context to infer intent intelligently. If they mention a goal they have, map it correctly.
11. For compound messages, extract ALL intents as separate actions.
12. Include "confidence": "high" | "medium" | "low" and "explanation" for each action. Calibrate it: "high" = the intent and every required scheduling field are clear and explicitly stated; "medium" = the intent is clear but exactly ONE schedule field is missing (a habit's days, a task's date, an event's time) — set that field in "missingFields"; "low" = you could not determine an actionable intent at all. A vague brain-dump with no action is NOT low — route it to "inbox_add" at "medium" or "high".
13. Output ONLY valid JSON: { "actions": [...] }
14. NEVER invent dateStr, time, startISO, endISO, or recurrence the user did not explicitly mention. If the user gave no time reference, omit those fields entirely. Confabulating dates is a serious failure.
15. Biweekly / every-other / every-N-weeks intent: WITH a clock time → "calendar_add" with recurrence { frequency:"weekly", interval:N, daysOfWeek:[...] } (a repeating timed calendar event). WITHOUT a clock time → "recurring_todo_add" with interval set (2 for biweekly, N for "every N weeks"). Phrasings that map to interval=2: "every other [day]", "every two weeks", "biweekly", "every 2 weeks", "every fortnight". The "recurring_add" (habit) schema does NOT support interval — untimed biweekly chores emit "recurring_todo_add". Only daysOfWeek-style phrasings with no clock (every Monday, every weekday, daily) use "recurring_add".
16. TITLE NORMALIZATION — the "title" field must contain ONLY the action itself, never the user's framing/request phrasing. ALWAYS strip these leading prefixes (case-insensitive) before writing the title: ${CAPTURE_FRAMING_PREFIXES.map((p) => `"${p}"`).join(', ')}. ALSO strip leading SCHEDULING verbs/phrases ("can you schedule", "can you add", "can you block", "can you put", "schedule", "add", "block", "put") AND any TRAILING schedule clause — the date/time/cadence tail (e.g. "for Sunday at 10am every week", "every Sunday at 10am", "every weekday at 6am", "at 5pm", "tomorrow at 2pm") — so the title is ONLY the activity. Also strip trailing politeness ("please", "thanks"). Capitalize the first letter of the resulting title. Examples: "can you set a reminder to clean the bins by the side of the house" → "Clean the bins by the side of the house"; "schedule a workout every Sunday at 10am every week" → "Workout"; "block every weekday at 6am for a run" → "Run". The presence of "remind me to" / "set a reminder" signals reminder intent but does NOT by itself determine the action type — apply the normal routing rules: if the user provided a date/time, emit "todo_add" with that date; if no date/time was given, emit "inbox_add" (per rule 7a). The framing phrase itself never belongs in the title text.

EXAMPLES:
User: "help with dinner tonight"
Output: { "actions": [{ "type": "todo_add", "title": "Help with dinner", "dateStr": "${todayStr}", "confidence": "high", "missingFields": [], "explanation": "One-off task for tonight." }] }

User: "schedule a workout every Sunday at 10am every week"
Output: { "actions": [{ "type": "calendar_add", "title": "Workout", "startISO": "<next Sunday>T10:00:00", "endISO": "<next Sunday>T11:00:00", "recurrence": { "frequency": "weekly", "daysOfWeek": [0], "interval": 1 }, "confidence": "high", "missingFields": [], "explanation": "Timed recurring block → repeating Apple Calendar event every Sunday at 10:00." }] }

User: "block every weekday at 6am for a run"
Output: { "actions": [{ "type": "calendar_add", "title": "Run", "startISO": "<next weekday>T06:00:00", "endISO": "<next weekday>T07:00:00", "recurrence": { "frequency": "weekly", "daysOfWeek": [1,2,3,4,5], "interval": 1 }, "confidence": "high", "missingFields": [], "explanation": "Timed recurring block → repeating calendar event on weekdays at 6am." }] }

User: "block every weekday at 5pm for COL content work"
Output: { "actions": [{ "type": "calendar_add", "title": "COL content work", "startISO": "<next weekday>T17:00:00", "endISO": "<next weekday>T18:00:00", "recurrence": { "frequency": "weekly", "daysOfWeek": [1,2,3,4,5], "interval": 1 }, "confidence": "high", "missingFields": [], "explanation": "Timed recurring block on weekdays at 5pm → repeating calendar event." }] }

User: "create a habit to read my mantras twice a day"
Output: { "actions": [{ "type": "recurring_add", "title": "Read mantras", "daysOfWeek": [0,1,2,3,4,5,6], "timesPerDay": 2, "confidence": "high", "missingFields": [], "explanation": "Identity habit — twice daily, no fixed clock time." }] }

User: "meditate every morning"
Output: { "actions": [{ "type": "recurring_add", "title": "Meditate", "daysOfWeek": [0,1,2,3,4,5,6], "preferredTimeBlock": "morning", "timesPerDay": 1, "confidence": "high", "missingFields": [], "explanation": "Daily morning meditation habit." }] }

User: "take out the trash every Sunday"
Output: { "actions": [{ "type": "recurring_todo_add", "title": "Take out the trash", "daysOfWeek": [0], "confidence": "high", "missingFields": [], "explanation": "Weekly chore — not identity-building, so recurring to-do." }] }

User: "remind me to call mom every other Tuesday"
Output: { "actions": [{ "type": "recurring_todo_add", "title": "Call mom", "daysOfWeek": [2], "interval": 2, "confidence": "high", "missingFields": [], "explanation": "Biweekly chore — interval=2 on Tuesdays." }] }

User: "biweekly check-in with Sean"
Output: { "actions": [{ "type": "recurring_todo_add", "title": "Check-in with Sean", "daysOfWeek": [], "interval": 2, "missingFields": ["daysOfWeek"], "confidence": "high", "explanation": "Biweekly cadence; weekday unspecified — flag missing days." }] }

User: "review finances every two weeks"
Output: { "actions": [{ "type": "recurring_todo_add", "title": "Review finances", "daysOfWeek": [], "interval": 2, "missingFields": ["daysOfWeek"], "confidence": "high", "explanation": "Biweekly chore; weekday unspecified — flag missing days." }] }

User: "submit invoices every 2 weeks on Friday"
Output: { "actions": [{ "type": "recurring_todo_add", "title": "Submit invoices", "daysOfWeek": [5], "interval": 2, "confidence": "high", "missingFields": [], "explanation": "Biweekly Fridays — interval=2 on Friday." }] }

User: "dentist tomorrow at 2pm"
Output: { "actions": [{ "type": "calendar_add", "title": "Dentist appointment", "startISO": "${tomorrowStr}T14:00:00", "endISO": "${tomorrowStr}T15:00:00", "confidence": "high", "missingFields": [], "explanation": "One-off calendar event." }] }

User: "add to my calendar a daily check-in with my wife for 20 minutes at 10:00 PM"
Output: { "actions": [{ "type": "calendar_add", "title": "Check-in with wife", "startISO": "${todayStr}T22:00:00", "endISO": "${todayStr}T22:20:00", "recurrence": { "frequency": "daily", "interval": 1 }, "confidence": "high", "missingFields": [], "explanation": "Explicit calendar reference + daily cadence + clock time → repeating 20-minute block at 10 PM." }] }

User: "put a 30 minute workout block on my calendar every morning at 7"
Output: { "actions": [{ "type": "calendar_add", "title": "Workout", "startISO": "${todayStr}T07:00:00", "endISO": "${todayStr}T07:30:00", "recurrence": { "frequency": "daily", "interval": 1 }, "confidence": "high", "missingFields": [], "explanation": "Explicit calendar reference + daily cadence + 7 AM clock → repeating 30-minute block." }] }

User: "call mom tomorrow at 3"
Output: { "actions": [{ "type": "todo_add", "title": "Call mom", "dateStr": "${tomorrowStr}", "time": "15:00", "confidence": "high", "missingFields": [], "explanation": "Action item with a soft time — phone calls go to todo, not calendar." }] }

User: "remind me to pick up dry cleaning Friday at 5"
Output: { "actions": [{ "type": "todo_add", "title": "Pick up dry cleaning", "dateStr": "<next Friday YYYY-MM-DD>", "time": "17:00", "confidence": "high", "missingFields": [], "explanation": "Errand reminder — todo with soft time." }] }

User: "can you set a reminder to clean the bins by the side of the house"
Output: { "actions": [{ "type": "inbox_add", "title": "Clean the bins by the side of the house", "confidence": "high", "missingFields": [], "explanation": "Reminder framing stripped from title. No date/time given — routes to Inbox." }] }

User: "set a reminder to spray the wash deck"
Output: { "actions": [{ "type": "inbox_add", "title": "Spray the wash deck", "confidence": "high", "missingFields": [], "explanation": "Reminder framing stripped from title. No date/time given — routes to Inbox." }] }

User: "add to my inbox: call the mortgage company, call the city, and change my bank accounts in my direct deposit"
Output: { "actions": [{ "type": "inbox_add", "title": "Call the mortgage company", "confidence": "high", "missingFields": [], "explanation": "Explicit inbox override — one inbox_add per listed item." }, { "type": "inbox_add", "title": "Call the city", "confidence": "high", "missingFields": [], "explanation": "Explicit inbox override — one inbox_add per listed item." }, { "type": "inbox_add", "title": "Change my bank accounts in my direct deposit", "confidence": "high", "missingFields": [], "explanation": "Explicit inbox override — one inbox_add per listed item." }] }

User: "think about Q1 strategy"
Output: { "actions": [{ "type": "inbox_add", "title": "Think about Q1 strategy", "confidence": "high", "missingFields": [], "explanation": "No time reference — pure capture, no dateStr or time." }] }

User: "workout"
Output: { "actions": [{ "type": "inbox_add", "title": "Workout", "confidence": "medium", "missingFields": [], "explanation": "Single word, no schedule — capture for triage." }] }`;

      if (grammarActions && grammarActions.length > 0) {
        // Tier-1 hit: the offline grammar resolved the capture — skip the AI
        // proxy entirely (instant, network-resilient). resolveCaptureTier still
        // re-gates the result below, exactly as for the AI path.
        normalizedActions = grammarActions;
      } else {
        const messages = [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: text },
        ];
        // NEX-280: hard deadline so a stalled proxy / wedged session lookup can
        // never strand isProcessing (which bricks the orb's tap guard).
        // NEX-283: explicit frontier-class router model (no DAILY_PULSE default).
        // NEX-317: strict Structured Outputs for an OpenAI-routable router model
        // (constrained decoding); json_object otherwise (the Anthropic route drops
        // response_format).
        const responseFormat = buildCommandResponseFormat(
          MODELS.COMMAND_ROUTER,
          COMMAND_ACTIONS_JSON_SCHEMA,
        );
        const aiStartedAt = Date.now();
        let content: string;
        try {
          content = await chatCompletion(messages, {
            model: MODELS.COMMAND_ROUTER,
            response_format: responseFormat,
            timeoutMs: COMMAND_AI_TIMEOUT_MS,
          });
        } catch (aiErr) {
          // NEX-317: fail OPEN on a strict-schema 400 — retry the SAME call in
          // json_object mode (the previously-working path) so a malformed/rejected
          // schema can never dead-end every capture. The retry runs on the REMAINING
          // original deadline, and only when at least MIN_FETCH_BUDGET_MS is left —
          // below that, chatCompletion's fetch floor would overshoot the deadline
          // (and hold the orb tap guard), so we rethrow to the low tier instead
          // (Greptile). Other errors (401 / timeout / 5xx) rethrow unchanged.
          const budgetMs = fallbackBudgetMs(
            Date.now() - aiStartedAt,
            COMMAND_AI_TIMEOUT_MS,
            MIN_FETCH_BUDGET_MS,
          );
          if (
            responseFormat.type === 'json_schema' &&
            isSchemaValidation400(aiErr) &&
            budgetMs !== null
          ) {
            addAppBreadcrumb('command', 'structured_output_fallback');
            content = await chatCompletion(messages, {
              model: MODELS.COMMAND_ROUTER,
              response_format: { type: 'json_object' },
              timeoutMs: budgetMs,
            });
          } else {
            throw aiErr;
          }
        }
        if (!content || typeof content !== 'string') throw new Error('AI response content missing.');

        const parsed = parseAIResponse(content);
        normalizedActions = parsed.actions.map((action) => coerceAction(action, text));
      }

      // NEX-280: a newer run started while this one awaited — this run must
      // not BEGIN executing or touch UI. (A run overtaken mid-executeActions
      // still finishes — aborting half-executed calendar writes would be
      // worse, and two distinct texts are two distinct intents; identical
      // ones are deduped by lastExecRef.)
      if (isStale()) return;

      // NEX-197: confidence-tier the capture. No pre-save form — high executes
      // immediately, medium asks one scoped chip question, low shows the
      // transcript and a retry.
      const resolution = resolveCaptureTier(normalizedActions, text, now);
      if (resolution.tier === 'high') {
        await executeActions(resolution.actions);
      } else if (resolution.tier === 'medium' && resolution.clarification) {
        haptic('buttonSecondary');
        setClarification({ actions: resolution.actions, clarification: resolution.clarification });
        announce('One quick question.');
      } else {
        haptic('voiceAmbiguous');
        addAppBreadcrumb('command', 'low_tier_shown', { reason: 'low_confidence' });
        setLowTierText(text);
        // Law A: a non-empty transcript can be saved verbatim; announce the save
        // path so screen-reader users know the words aren't lost.
        announce(
          text.trim()
            ? "I couldn't sort that. Save it to Inbox or try again."
            : "I didn't catch that. Tap to try again.",
        );
      }
    } catch (err: unknown) {
      if (isStale()) return; // a newer run owns the UI now
      const message = err instanceof Error ? err.message : 'Unable to generate proposal.';
      // Genuine config errors keep their own handling; a failed/garbled parse
      // OR a deadline miss (NEX-280: stalled proxy / wedged session lookup)
      // becomes the low tier ("I didn't catch that") rather than a scary alert.
      const isParseFailure = (PARSE_FAILURE_MESSAGES as readonly string[]).includes(message);
      const isTimeout = err instanceof AiTimeoutError || err instanceof SessionTimeoutError;
      // NEX-283: an upstream model/API rejection (a 4xx/5xx the proxy forwards
      // verbatim, e.g. a model id or response_format the API refuses) is not
      // user-actionable — §9.4 / Law C: the orb never scolds or alarms. It
      // falls to the same gentle retry; breadcrumbs keep the debug signal.
      const isAiRequestFailure = message.startsWith('AI request failed (');
      if (isParseFailure || isTimeout || isAiRequestFailure) {
        haptic('voiceAmbiguous');
        const { reason, status } = classifyLowTierReason(err);
        addAppBreadcrumb('command', 'low_tier_shown', {
          reason,
          ...(status !== undefined ? { status } : {}),
        });
        setLowTierText(text);
        announce(
          text.trim()
            ? "I couldn't sort that. Save it to Inbox or try again."
            : "I didn't catch that. Tap to try again.",
        );
      } else if (message !== 'OpenAI key missing. Save it securely to continue.') {
        Alert.alert('Engine Error', message);
      }
    } finally {
      // Breadcrumb pairs with processing_started per run — never gate it on
      // staleness or the App-Hang repro trails desync (NEX-280).
      addAppBreadcrumb('command', 'processing_ended');
      if (!isStale()) {
        setIsProcessing(false);
        setIsDebriefing(false);
        setManualCommand('');
      }
    }
  };


  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      // If the user backgrounds mid-record, stop the recognizer cleanly so
      // it doesn't leave the audio session in .measurement mode while the
      // app sits in the background. expo-av Recording handles its own
      // pause-on-background. Also drop the orb out of 'listening' and clear the
      // partial transcript — otherwise the next foreground tap runs the stop
      // branch and generates a proposal from a stale, half-captured transcript.
      if (nextState !== 'active' && liveTranscript.isRecognizing) {
        void liveTranscript.stop();
        setOrbState('idle');
        setManualCommand('');
        liveTranscript.reset();
      }
    });
    return () => { subscription?.remove?.(); };
  }, [liveTranscript]);


  const dismissCapture = () => {
    haptic('buttonSecondary');
    setClarification(null);
    setLowTierText(null);
    dismissLedger();
    liveTranscript.reset();
  };

  // NEX-318 (Phase 2): live preview from the OFFLINE grammar only (no AI per
  // keystroke), debounced. The generation ref invalidates a stale debounce; the
  // effect clears the preview while a command is executing/processing or another
  // card is up, so there is never a second primary action on screen. The cleanup
  // clears the timer on every change/unmount (no post-unmount setState).
  useEffect(() => {
    if (isProcessing || isExecuting || clarification || lowTierText) {
      setPreview(null);
      return;
    }
    const text = manualCommand;
    if (!text.trim()) {
      setPreview(null);
      return;
    }
    const gen = ++previewGenRef.current;
    const id = setTimeout(() => {
      if (gen !== previewGenRef.current) return; // superseded by a newer keystroke
      setPreview(projectCommandPreview(text, new Date()));
    }, 250);
    return () => clearTimeout(id);
  }, [manualCommand, isProcessing, isExecuting, clarification, lowTierText]);

  // NEX-318: confirm the live preview. Bound to sourceText (never commit a parse
  // the user has since edited), gated against an in-flight commit, and — for the
  // irreversible calendar case — re-run through resolveCaptureTier rather than
  // executed blind, so every tier-gate safety still applies. A gate result that
  // isn't the intended high-tier action defers to the normal AI submit flow.
  const handlePreviewAdd = async (dateStr?: string) => {
    if (isProcessing || isExecuting) return;
    const current = preview;
    if (!current) return;
    if (manualCommand.trim() !== current.sourceText.trim()) {
      setPreview(null);
      return;
    }
    const now = new Date();
    const action = dateStr ? applyPreviewDate(current.action, dateStr) : current.action;
    if (
      action.type === 'calendar_add' &&
      action.startISO &&
      new Date(action.startISO).getTime() < now.getTime()
    ) {
      return; // never write a past event
    }
    const resolution = resolveCaptureTier([action], current.sourceText, now);
    if (resolution.tier !== 'high') {
      // The gate wants a clarification/Inbox — hand off to the full submit flow.
      setPreview(null);
      captureOriginRef.current = 'typed';
      void generateProposal(manualCommand);
      return;
    }
    setPreview(null);
    setManualCommand('');
    haptic('buttonPrimary');
    await executeActions(resolution.actions);
  };

  // NEX-197: the single medium-tier exchange. Patch the targeted action(s) with
  // the chosen chip, validate ONCE (never re-ask), execute. Any target the chip
  // somehow can't make valid is captured to Inbox — visible, never silently lost.
  const applyClarification = (chip: ClarificationChip) => {
    if (!clarification) return;
    const { actions, clarification: spec } = clarification;
    const finalized = actions.map((action, idx) => {
      if (!spec.targetIndices.includes(idx)) return action;
      const patched = normalizeProposedAction({ ...action, ...chip.patch });
      return validateProposedAction(patched).valid ? patched : inboxFallback(patched, spec.fieldKey);
    });
    setClarification(null);
    void executeActions(finalized);
  };

  // Law A safety net: save the unsorted transcript verbatim to Inbox. Routes
  // through executeActions so the item is saved AND surfaced with the ledger,
  // capture echo, and location-bearing confirmation. Crucially we do NOT clear
  // lowTierText here — executeActions clears it synchronously ONLY when it
  // actually runs (line ~1181); if it bails (isExecuting / lock / 3s dedupe)
  // the card stays up, so a swallowed tap can never drop the words (a Law A P0
  // regression). The `busy` prop on the card also disables the button while a
  // save is in flight.
  const saveLowTierToInbox = () => {
    const trimmed = (lowTierText ?? '').trim();
    if (!trimmed) return; // the empty-capture sentinel has nothing to save
    haptic('buttonPrimary');
    void executeActions([buildTranscriptInboxAction(trimmed)]);
  };

  // NEX-197: low-tier retry. Clear the transcript, then re-arm capture the way
  // the user reached it — re-record for voice, refocus the field for typed.
  const retryLowTier = () => {
    haptic('buttonSecondary');
    setLowTierText(null);
    liveTranscript.reset();
    setManualCommand('');
    if (captureOriginRef.current === 'voice') {
      void handleVoiceOrbPress();
    } else {
      manualInputRef.current?.focus();
    }
  };

  const handleOrbPress = () => {
    if (recording) stopRecording();
    else startRecording(false);
  };

  const startRecording = async (debriefMode = false) => {
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Microphone Required', 'Microphone access is required for voice commands.');
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      // Start expo-av Recording first — it owns the canonical audio for
      // Whisper. The recognizer joins the session afterwards.
      const created = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      setRecording(created.recording);
      // Path C: kick off the live recognizer in parallel for interim
      // preview text. If permission is denied, we silently fall back to
      // Whisper-only — the orb's existing pipeline still works without
      // live preview.
      liveTranscript.start({ continuous: true }).catch(() => {
        // Already logged in the hook; non-fatal.
      });
      if (debriefMode) setIsDebriefing(true);
      setClarification(null);
      setLowTierText(null);
      dismissLedger();
      haptic('voiceStart');
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : '';
      let message: string;
      if (raw.includes('audio session could not be activated') || raw.includes('EXModulesErrorDomain') || raw.includes('background')) {
        message = 'Another app is using your microphone (screen sharing, a call, or a recording). Close it and try again.';
      } else if (raw.includes('not permitted') || raw.includes('permission')) {
        message = 'Microphone permission is required. Enable it in Settings -> Nexus.';
      } else {
        message = 'Unable to start recording. Please try again.';
      }
      Alert.alert('Mic Unavailable', message);
    }
  };

  const stopRecording = async () => {
    if (!recording) return;
    setIsProcessing(true);
    setRecording(null);
    // Stop the recognizer first so its final 'result' event lands and we
    // can read getLastFinal() as a fallback if Whisper fails.
    await liveTranscript.stop();
    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      if (!uri) throw new Error('No recording URI');
      let transcribedText = '';
      try {
        // Whisper round-trip with a 12s timeout — long enough for a normal
        // command, short enough that a hung network falls through to the
        // recognizer fallback instead of stalling the UI.
        transcribedText = await Promise.race([
          transcribeAudio(uri),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('Transcription timeout')), 12000)
          ),
        ]);
      } catch (whisperErr: any) {
        const fallback = liveTranscript.getLastFinal()?.trim();
        if (fallback) {
          if (__DEV__) console.log('[command] Whisper failed, using recognizer fallback:', whisperErr?.message);
          transcribedText = fallback;
        } else {
          throw whisperErr;
        }
      }
      if (transcribedText && typeof transcribedText === 'string' && transcribedText.trim().length > 0) {
        if (isDebriefing && typeof setNightlyForward === 'function') {
          try {
            const liveState: any = useAppState.getState?.() ?? {};
            const fwdText = await chatCompletion([{
              role: 'user',
              content: `Based on this nightly debrief: "${transcribedText}"
And this person's vision: "${liveState.userProfile?.vision ?? ''}"
Write ONE sentence they should carry into tomorrow. Be direct and specific. No filler.`
            }]);
            if (fwdText) setNightlyForward(fwdText.trim());
          } catch {}
        }
        await generateProposal(transcribedText);
      } else {
        throw new Error('Transcription returned no usable text.');
      }
    } catch (error: any) {
      Alert.alert('Voice Error', error.message || 'Unable to process voice input.');
      setIsProcessing(false);
      setIsDebriefing(false);
    } finally {
      // Reset the audio session so the recognizer's .measurement mode
      // doesn't dampen subsequent app playback (issue #72). One ratchet
      // back to the default category. If this proves insufficient on a
      // given iOS version, we'll add a setAudioSessionActiveIOS(false)
      // call before this line.
      try {
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      } catch {
        // Non-fatal — user-visible cost is quieter playback until the
        // next setAudioMode call elsewhere in the app.
      }
      liveTranscript.reset();
    }
  };

  const isPeak = capacity === 'PEAK';
  // FIXME(nex-56): orb state palette — 6 semantic colors (gold/white/purple/red/blue/red/green),
  // design review needed (CLAUDE.md doesn't define a state-color system for the AI orb).
  // Reviewing this state machine piecewise is worse than reviewing it whole — surface-pass
  // ticket should propose orb.statePeak/Recovery/Recording/Debriefing/Processing/Error/Ready/Just-Added.
  // FIXME(nex-56): orb-palette peak/recovery initial state — see palette block above
  let orbColor = isPeak ? tokens.color.gold : tokens.color.text;
  let orbScale: number | number[] = isPeak ? [1, 1.05, 1] : 1;
  let statusMsg = isPeak ? 'TAP TO SPEAK' : 'RECOVERY PROTOCOL';

  if (recording || orbState === 'listening') {
    // Key the listening label/color off the SAME signal as the "I'm listening."
    // subtitle (orbState), not only the expo-av `recording` object — otherwise
    // the label desyncs (e.g. on the simulator, where audio capture never
    // starts so `recording` stays null while the orb shows listening).
    // FIXME(nex-56): orb-palette debriefing/listening — see palette block above
    orbColor = isDebriefing ? tokens.color.nebulaMagenta : tokens.color.stateError;
    statusMsg = isDebriefing ? 'TAP TO FINISH DEBRIEF' : 'TAP WHEN DONE';
  } else if (isProcessing || isExecuting) {
    // FIXME(nex-56): orb-palette processing — see palette block above
    orbColor = tokens.color.stateInfo;
    statusMsg = 'ANALYZING INTENT...';
  } else if (clarification) {
    // NEX-197: medium tier — one scoped question is on screen.
    orbColor = tokens.color.teal;
    statusMsg = 'ONE QUICK QUESTION';
    orbScale = 1;
  } else if (lowTierText) {
    // NEX-197: low tier — couldn't parse; transcript + retry is on screen.
    // Mirror the card's two states: heard-but-unsorted vs nothing heard.
    orbColor = tokens.color.stateInfo;
    statusMsg = lowTierText.trim() ? "I COULDN'T SORT THAT" : "I DIDN'T CATCH THAT";
    orbScale = 1;
  } else if (justAdded) {
    // FIXME(nex-56): orb-palette just-added — see palette block above
    orbColor = tokens.color.teal;
    statusMsg = 'ADDED';
    orbScale = 1;
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.container}>
      {/* NEX-? — Command tab full-bleed restructure. VoiceOrb fills the
          entire tab; the prompt + input float in an absolute overlay
          pinned to the bottom over the orb's transparent fade.
          Replaces the previous ScrollView + centerStage layout.
          (PulseCard removed 2026-05-23 per NEX-83.) */}
      <VoiceOrb
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        state={orbState}
        onPress={handleVoiceOrbPress}
        accessibilityLabel={orbState === 'listening' ? 'Listening' : 'Voice command'}
        accessibilityHint={orbState === 'listening' ? 'Double tap to stop and send' : 'Double tap to speak'}
      />
      <LinearGradient
        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.65)', 'rgba(0,0,0,0.88)']}
        locations={[0, 0.55, 1]}
        pointerEvents="none"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%' }}
      />
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: keyboardOffset > 0 ? keyboardOffset + 12 : 80, paddingHorizontal: tokens.spacing.lg, alignItems: 'center' }}>
      <View style={{ width: '100%', maxWidth: isWide ? contentMaxWidth : undefined }}>
        {/* Live transcript renders in the manual input field below via the
            useEffect that mirrors liveTranscript → manualCommand. The upper
            preview box was removed 2026-05-24 because it duplicated the
            bottom input visually during recording. */}
        {/* Tap-to-speak / tap-to-stop affordance. The poetic prompt below
            tells the user what to say; this brutalist micro-label tells
            them HOW to start and stop. Hidden once a proposal is on
            screen — the action plan is its own affordance. */}
        {!clarification && !lowTierText && !justAdded && (
          <Text
            style={[
              tokens.type.labelTrackedSm,
              {
                color: recording || orbState === 'listening' ? tokens.color.teal : tokens.color.textMuted,
                textAlign: 'center',
                marginBottom: tokens.spacing.xs,
              },
            ]}
          >
            {statusMsg}
          </Text>
        )}
        {orbState === 'idle' ? (
          <Text style={[tokens.type.poeticMd, { color: tokens.color.text, textAlign: 'center', marginBottom: tokens.spacing.md }]}>
            What needs to happen today?
          </Text>
        ) : showWaveform ? (
          <CommandWaveform heights={waveHeights} />
        ) : (
          <Text style={[tokens.type.poeticMd, { color: tokens.color.text, textAlign: 'center', marginBottom: tokens.spacing.md }]}>
            {"I'm listening."}
          </Text>
        )}

        {/* NEX-166: quiet, non-blocking recall affordance. Before the first
            successful command it nudges discovery; after, it stays as a way to
            recall the examples. Opens the same example sheet. */}
        {!clarification && !lowTierText && !justAdded && !showCommandTip && !preview && (
          <Pressable
            onPress={() => setShowCommandTip(true)}
            hitSlop={8}
            style={{ alignSelf: 'center', marginBottom: tokens.spacing.md }}
            accessibilityRole="button"
            accessibilityLabel={firstCommandDone ? 'What can I say' : 'See command examples'}
          >
            <Text style={[tokens.type.labelTrackedSm, { color: tokens.color.textMuted, textAlign: 'center' }]}>
              {firstCommandDone ? 'WHAT CAN I SAY?' : 'NOT SURE WHAT TO SAY? SEE EXAMPLES'}
            </Text>
          </Pressable>
        )}

        {/* NEX-260 (L-5): quiet entry to the solo structured-start (presence,
            not performance). Secondary affordance only — no new tab. */}
        {!clarification && !lowTierText && !justAdded && !showCommandTip && !preview && (
          <Pressable
            onPress={() => setShowStructuredStart(true)}
            hitSlop={8}
            style={{ alignSelf: 'center', marginBottom: tokens.spacing.md }}
            accessibilityRole="button"
            accessibilityLabel="Start something. Name what you are about to do and optionally hold a focus timer"
          >
            <Text style={[tokens.type.labelTrackedSm, { color: tokens.color.textMuted, textAlign: 'center' }]}>
              START SOMETHING
            </Text>
          </Pressable>
        )}

        {/* Coach thread (docs/plans/2026-09-02-coach-conversation.md): a
            labeled entry to the conversation, never a gesture, never a sixth
            tab. Quick capture stays one-shot; the thread is a deliberate mode. */}
        {!clarification && !lowTierText && !justAdded && !showCommandTip && !preview && (
          <Pressable
            onPress={() => router.push('/coach' as never)}
            hitSlop={8}
            style={{ alignSelf: 'center', marginBottom: tokens.spacing.md }}
            accessibilityRole="button"
            accessibilityLabel="Talk it through. A conversation that ends in a plan on your Home"
          >
            <Text style={[tokens.type.labelTrackedSm, { color: tokens.color.textMuted, textAlign: 'center' }]}>
              TALK IT THROUGH
            </Text>
          </Pressable>
        )}


        {/* NEX-197: medium tier — one scoped chip question, no form. */}
        <AnimatePresence>
          {clarification && (
            <CommandClarification
              title={clarification.actions[clarification.clarification.targetIndices[0] ?? 0]?.title ?? ''}
              clarification={clarification.clarification}
              onPickChip={applyClarification}
              onDismiss={dismissCapture}
              busy={isExecuting}
            />
          )}
        </AnimatePresence>

        {/* NEX-318 (Phase 2): live preview of what will happen, as the user types. */}
        <AnimatePresence>
          {preview && !clarification && !lowTierText && !justAdded && !isProcessing && !isExecuting && (
            <CommandPreviewCard
              preview={preview}
              onAdd={handlePreviewAdd}
              onDismiss={() => setPreview(null)}
              busy={isExecuting || isProcessing}
            />
          )}
        </AnimatePresence>

        {/* NEX-197: low tier — verbatim transcript + try again. */}
        <AnimatePresence>
          {lowTierText && (
            <CommandLowTier
              transcript={lowTierText}
              onTryAgain={retryLowTier}
              onDismiss={dismissCapture}
              onSaveToInbox={saveLowTierToInbox}
              busy={isExecuting}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {executionLedger && !clarification && !lowTierText && (
            <CommandExecutionLedger
              ledger={executionLedger}
              retryingLedgerKeys={retryingLedgerKeys}
              onRetryItem={retryExecutionLedgerItem}
              onUndoItem={handleUndoLedgerItem}
              onJumpItem={handleJumpLedgerItem}
              onAcceptTimeBlock={handleAcceptLedgerTimeBlock}
              onUndoTimeBlock={handleUndoLedgerTimeBlock}
              onAcceptBreakdown={handleAcceptLedgerBreakdown}
              onUndoBreakdown={handleUndoLedgerBreakdown}
              breakdownGrain={breakdownGrain}
              onDismiss={dismissLedger}
            />
          )}
        </AnimatePresence>

        {!clarification && !lowTierText && (
          <>
            <View style={styles.manualInputWrapper}>
              <TextInput
                ref={manualInputRef}
                style={styles.manualInput}
                placeholder="Type or tap the orb to speak..."
                placeholderTextColor={PLACEHOLDER_COLOR}
                accessibilityLabel="Type a command"
                accessibilityHint="Sends to Nexus when you submit"
                value={manualCommand}
                onChangeText={(t) => {
                  // User edited manually — clear voice error if it was up.
                  if (voiceError) setVoiceError(null);
                  setManualCommand(t);
                }}
                onSubmitEditing={() => {
                  // NEX-318: if a live preview is up, keyboard "send" CONVERGES to
                  // it rather than launching the AI in parallel (no double-execute).
                  // An ambiguous-date preview needs an explicit chip, so send is a
                  // no-op there.
                  if (preview) {
                    if (!preview.dateCandidates) void handlePreviewAdd();
                    return;
                  }
                  captureOriginRef.current = 'typed';
                  void generateProposal(manualCommand);
                }}
                returnKeyType="send"
                autoCorrect={false}
              />
            </View>
            {voiceError && (
              <Text
                style={{
                  color: tokens.color.stateError,
                  fontSize: 13,
                  marginTop: tokens.spacing.xs,
                  textAlign: 'center',
                }}
              >
                {voiceError}
              </Text>
            )}
            {/* Pulse card removed 2026-05-23 (NEX-83) — preserved as deprecated module, not deleted.
                Re-introduction must be narrowly scoped to ONE specific job (e.g., single at-risk habit,
                overdue mandate action) or stay removed. The orb is already the AI affordance. */}
          </>
        )}
      </View>
      </View>


      {/* NEX-260 (L-5): conditionally mounted so unmount fires STT + timer
          cleanup on every dismiss path (see structured-start.tsx). */}
      {showStructuredStart && (
        <StructuredStart onDismiss={() => setShowStructuredStart(false)} />
      )}

      <Modal visible={showCommandTip} transparent animationType="slide" statusBarTranslucent>
        {/* Full-screen dismiss scrim — hidden from VoiceOver; the sheet has a Close button. */}
        <Pressable
          style={{ flex: 1 }}
          onPress={dismissCommandTip}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
        {/* FIXME(nex-56): tokens.color.surface off-scale dark (not in table; ~surface #111113 but stylistically distinct) — design review */}
        {/* FIXME(nex-56): tokens.color.goldHairline neutral dark border, no token — design review (CLAUDE.md §6.2 wants gold hairline) */}
        {/* FIXME(nex-56): off-scale spacing 28 — between lg(24) and xl(32), review */}
        {/* FIXME(nex-56): off-scale spacing 40 — between xl(32) and xxl(48), review */}
        <View accessibilityViewIsModal style={{ backgroundColor: tokens.color.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: tokens.color.goldHairline, borderBottomWidth: 0, padding: 28, paddingBottom: 40 }}>
          <View style={{ alignItems: 'center', marginBottom: tokens.spacing.md }}>
            {/* FIXME(nex-56): tokens.color.textDisabled off-scale gray; map to textMuted or design review */}
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: tokens.color.textDisabled, marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ }} />
          </View>
          {/* FIXME(nex-56): off-scale fontSize 10, design review */}
          <Text style={{ color: tokens.color.gold, fontSize: 10, fontWeight: '900', letterSpacing: 3, marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ }}>COMMAND CENTER</Text>
          {/* FIXME(nex-56): fontSize 18 matches titleCard size but fontWeight '800' ≠ token '600' — design review (no bulk weight shift per migration rule) */}
          <Text style={{ color: tokens.color.text, fontSize: 18, fontWeight: '800', marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ }}>This is the orb</Text>
          {/* FIXME(nex-56): tokens.color.textSecondary off-scale gray — design review */}
          {/* FIXME(nex-56): fontSize 13 matches caption size but fontWeight default ≠ token '500' — design review */}
          <Text style={{ color: tokens.color.textSecondary, fontSize: 13, lineHeight: 20, marginBottom: tokens.spacing.md }}>
            Tap the orb and say what you need. For example:
          </Text>
          {/* NEX-166: concrete example phrases (reused from COMMAND_EXAMPLES) so a
              first-run user knows what to say, instead of a blank canvas. */}
          <View style={{ alignSelf: 'stretch', gap: tokens.spacing.xs, marginBottom: tokens.spacing.lg }}>
            {COMMAND_EXAMPLES.slice(0, 3).map((ex) => (
              <Text key={ex.text} style={{ color: tokens.color.text, fontSize: 14, lineHeight: 22 }}>
                <Text style={{ color: tokens.color.gold }}>{'▸  '}</Text>{ex.text}
              </Text>
            ))}
          </View>
          <Pressable style={{ backgroundColor: tokens.color.gold, borderRadius: 14, paddingVertical: tokens.spacing.md, alignItems: 'center' }} onPress={dismissCommandTip} accessibilityRole="button" accessibilityLabel="Close">
            {/* FIXME(nex-56): off-scale fontSize 12, design review */}
            <Text style={{ color: tokens.color.textInverse, fontSize: 12, fontWeight: '900', letterSpacing: 2 }}>GOT IT</Text>
          </Pressable>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent'},
  centerStage: { alignItems: 'center', paddingHorizontal: 25 /* FIXME(nex-56): off-scale spacing 25 — between lg(24) and xl(32), review */, width: '100%' },
  orb: { width: 140, height: 140, borderRadius: 70, marginBottom: 30 /* FIXME(nex-56): off-scale spacing 30 — between lg(24) and xl(32), review */, shadowColor: tokens.color.gold, shadowOpacity: 0.2, shadowRadius: 30 },
  // FIXME(nex-56): off-scale fontSize 11, design review
  statusText: { color: tokens.color.gold, fontSize: 11, fontWeight: '900', letterSpacing: 4, marginBottom: 30 /* FIXME(nex-56): off-scale spacing 30 — review */, textAlign: 'center' },
  // liveTranscript / liveTranscriptText styles removed 2026-05-25 — upper
  // preview component was deleted in PR #19, transcript now lives only in
  // the manualInput field below.
  manualInputWrapper: { width: '100%', backgroundColor: tokens.color.surface, borderRadius: 20, borderWidth: 1, borderColor: tokens.color.goldHairline, padding: 15 /* FIXME(nex-56): off-scale spacing 15 — review */, ...ambientGlowSoft },
  // FIXME(nex-56): off-scale fontSize 14, design review
  manualInput: { color: tokens.color.text, fontSize: 14, textAlign: 'center' },
});
