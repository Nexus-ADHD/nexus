/**
 * coach-turn.ts — one turn of the coach thread, as pure functions.
 *
 * RN-free, store-free, network-free (vitest-coverable). The screen does the
 * I/O (chatCompletion) and the store writes; everything decidable without
 * them lives here:
 *
 *   buildCoachContext   the "What you know" block. Built from the same
 *                       PatternData `buildAIContext()` returns, minus the two
 *                       things Law C forbids the coach from ever seeing: the
 *                       per-habit "skipped Mon & Tue" clause and the weakest
 *                       day. The mandates block is included once.
 *   buildCoachMessages  system prompt + the newest COACH_CONTEXT_MESSAGES
 *                       turns + the new user line.
 *   classifySafety      deterministic pre-flight on the user's words. A hit
 *                       replaces the model call with the fixed hand-off line
 *                       and suppresses any plan (S1.3).
 *   checkReplyTone      deterministic post-flight on the model's reply
 *                       (absence counts, commands, exclamation, em dash). A
 *                       violation is a FAILED turn with a reason, never a
 *                       silently shipped line (S1.2).
 *   parseCoachTurn      the JSON turn → a typed result. Plan actions go
 *                       through coerceAction and resolveCaptureTier exactly as
 *                       a Command capture does; only a high tier yields
 *                       executable actions, and nothing here executes (S2.2).
 */

import { MODELS } from '../../utils/ai-models';
import { COACH_SYSTEM_PROMPT } from '../../ai/prompts';
import type { ProposedAction } from '../command/command-types';
import { coerceAction } from '../command/command-parser';
import { resolveCaptureTier } from '../command/confidence-tier';
import { validateProposedAction } from '../../utils/recurrence';
import { buildCommandResponseFormat, type CommandResponseFormat } from '../command/structured-output';
import { COMMAND_ACTIONS_JSON_SCHEMA } from '../command/command-schema';
import { getProposalExecutionKey } from '../command/command-executor';
import { contextMessages, type CoachMessage, type CoachPendingPlan, type CoachThread } from './coach-thread';

/** The tier this surface runs on (models.js). Referenced here so NEX-305's no-dead-tier test sees it. */
export const COACH_MODEL: string = MODELS.COACH;

/** Same shape as ai-client's ChatMessage, declared locally so this module stays RN-free. */
export interface CoachChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ─── Context ────────────────────────────────────────────────────────────────

/** The fields of `buildAIContext()`'s PatternData this module reads. All optional. */
export interface CoachContextInput {
  name?: string;
  todayKey?: string;
  dayOfWeek?: string;
  /** Pause Mode active now (a planned break). */
  pausedNow?: boolean;
  todayIntention?: string;
  habitPatterns?: string;
  todayHabitProgress?: string;
  pendingTasks?: string;
  todayScore?: number | null;
  yesterdayScore?: number | null;
  weekAvgScore?: number | null;
  bestDayThisWeek?: string;
  topHabitReps?: string;
  mandatesSummary?: string;
  mandatesDetail?: string;
}

/**
 * ai-context's habit patterns read "Read: 5/7 days, skipped Mon & Tue. ...".
 * Both halves count an absence (Law C), the ratio by arithmetic. The coach
 * gets the habit NAMES only; what is due today arrives via todayHabitProgress.
 */
export function habitNamesOnly(habitPatterns: string): string {
  return habitPatterns
    .split(/\.\s+|\.$/)
    .map((seg) => seg.split(':')[0].trim())
    .filter((name) => name && !/^paused$/i.test(name))
    .join(', ');
}

/** @deprecated kept for one release; use habitNamesOnly. Strips only the clause. */
export function stripAbsenceClauses(habitPatterns: string): string {
  return habitPatterns.replace(/,\s*skipped\s+[^.]*?(?=(\.\s|\.$|$))/g, '');
}

/**
 * The "What you know" block. Deliberately NOT `contextString`: that string
 * carries "skipped ..." and "Weakest day" (ai-context.ts), which the coach
 * must never be handed, and the mandates block, which would otherwise be sent
 * twice. Scores stay: they are the person's own numbers, not an absence.
 */
export function buildCoachContext(input: CoachContextInput): string {
  const parts: string[] = [];
  if (input.name) parts.push(`Name: ${input.name}`);
  if (input.dayOfWeek || input.todayKey) parts.push(`Today: ${[input.dayOfWeek, input.todayKey].filter(Boolean).join(', ')}`);
  if (input.pausedNow) parts.push('Status: Pause Mode active (a planned break). Expectations are paused; nothing is late.');
  if (input.todayIntention) parts.push(`Today's intention: "${input.todayIntention}"`);
  if (input.habitPatterns) {
    const names = habitNamesOnly(input.habitPatterns);
    if (names) parts.push(`Habits: ${names}`);
  }
  if (input.todayHabitProgress) parts.push(`Today: ${input.todayHabitProgress}`);
  if (input.pendingTasks) parts.push(`Pending tasks: ${input.pendingTasks}`);
  if (typeof input.todayScore === 'number') parts.push(`Today's score: ${input.todayScore}/100`);
  if (typeof input.yesterdayScore === 'number') parts.push(`Yesterday: ${input.yesterdayScore}/100`);
  if (typeof input.weekAvgScore === 'number') parts.push(`7-day avg: ${input.weekAvgScore}/100`);
  if (input.bestDayThisWeek) parts.push(`Best day: ${input.bestDayThisWeek}`);
  if (input.topHabitReps) parts.push(`Most reps: ${input.topHabitReps}`);
  if (input.mandatesSummary) parts.push(`Mandates: ${input.mandatesSummary}`);
  const head = parts.join('. ') + (parts.length ? '.' : '');
  return input.mandatesDetail ? `${head}\nTheir mandates:\n${input.mandatesDetail}` : head;
}

// ─── Messages ───────────────────────────────────────────────────────────────

export function buildCoachMessages(args: {
  context: string;
  thread: CoachThread;
  userText: string;
}): CoachChatMessage[] {
  const system = `${COACH_SYSTEM_PROMPT}\n\nWhat you know:\n${args.context || '(nothing yet)'}`;
  // Notes are the thread talking to itself and the opener is the day's first
  // line, not a reply to anything: neither is conversation the model should
  // see as its own prior turn (an assistant message with no user turn before
  // it is also the one message shape some chat APIs reject).
  const history: CoachChatMessage[] = contextMessages(args.thread)
    .filter((m) => m.kind !== 'note' && m.kind !== 'opener')
    .map((m: CoachMessage) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
  return [{ role: 'system', content: system }, ...history, { role: 'user', content: args.userText }];
}

/** `response_format` for the coach call: strict schema on OpenAI, JSON mode on Kimi/Claude. */
export function coachResponseFormat(model: string = COACH_MODEL): CommandResponseFormat {
  return buildCommandResponseFormat(model, COACH_TURN_JSON_SCHEMA);
}

export const COACH_TURN_JSON_SCHEMA = {
  name: 'coach_turn',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reply', 'plan'],
    properties: {
      reply: { type: 'string' },
      plan: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['actions'],
            properties: { actions: COMMAND_ACTIONS_JSON_SCHEMA.schema.properties.actions },
          },
          { type: 'null' },
        ],
      },
    },
  },
} as const;

// ─── Safety ─────────────────────────────────────────────────────────────────

export type SafetyCategory = 'self-harm' | 'harm-to-others' | 'abuse' | 'medical';

export interface SafetyResult {
  hit: boolean;
  category: SafetyCategory | null;
}

// Deterministic vocabularies, the same shape as the NEX-277 quote filter: a
// hit is a hard stop, never a probability. Word-bounded so "killing it at
// work" does not trip; the phrases below are the ones that should.
const SAFETY_RULES: { category: SafetyCategory; re: RegExp }[] = [
  { category: 'self-harm', re: /\b(kill(ing)? myself|end (my|it all|my life)|suicid(e|al)|self[- ]?harm|hurt(ing)? myself|cut(ting)? myself|don'?t want to (live|be alive|be here|wake up)|no reason to (live|go on))\b/i },
  { category: 'harm-to-others', re: /\b(kill (him|her|them|someone)|hurt (him|her|them|someone) (badly|for real)|going to (hit|beat|hurt) (him|her|them))\b/i },
  { category: 'abuse', re: /\b((he|she|they) (hit|hits|beat|beats|choked|chokes) me|(being|been|got) (abused|assaulted|raped|molested)|sexual(ly)? (abuse|assault)|touch(ed|es|ing) (me|her|him) (inappropriately|sexually)|(hits|beats|hurts) (my|the) (kid|kids|child|children|daughter|son))\b/i },
  { category: 'medical', re: /\b(overdos(e|ed|ing)|can'?t breathe|chest pain|heart attack|stroke|unconscious|not breathing|seizure)\b/i },
];

export function classifySafety(text: string): SafetyResult {
  const t = (text ?? '').replace(/\s+/g, ' ');
  for (const rule of SAFETY_RULES) {
    if (rule.re.test(t)) return { hit: true, category: rule.category };
  }
  return { hit: false, category: null };
}

/**
 * The fixed hand-off line (§18: declarative, no exclamation, no em dash).
 * Not model-generated, so it cannot drift.
 */
export const SAFETY_HANDOFF_LINE =
  'This is bigger than a plan. It needs a person, today. In the US, call or text 988. Anywhere, your local emergency number. If you are safe right now, the thread is here when you are ready.';

// ─── Tone ───────────────────────────────────────────────────────────────────

export type ToneViolation = 'absence-count' | 'command' | 'exclamation' | 'em-dash' | 'diagnosis';

export interface ToneResult {
  ok: boolean;
  violations: ToneViolation[];
}

const ABSENCE_COUNT_RES: RegExp[] = [
  // "you haven't logged in 4 days", "missed 3 days", "skipped twice", "3 days without", "gone for a week"
  /\b(haven'?t|hasn'?t|didn'?t|did not|have not|has not|missed|skipped|gone|absent|away)\b[^.!?]{0,40}\b(\d+|two|three|four|five|six|seven|eight|nine|ten|twice|several|couple of|few)\s*(days?|weeks?|times|sessions?|mornings?|nights?)\b/i,
  /\b(\d+|two|three|four|five|six|seven)\s*(days?|weeks?)\s+(without|since (you|your) last|of (missing|skipping)|missed|skipped)\b/i,
  /\byou (missed|skipped)\b/i,
];
const COMMAND_RES: RegExp[] = [
  /\byou (need|have|ought) to\b/i,
  /\byou should\b/i,
  /\byou must\b/i,
  /\bdon'?t forget\b/i,
  /\bmake sure (you|to)\b/i,
];
const DIAGNOSIS_RES: RegExp[] = [
  /\b(you (have|are suffering from|might have|probably have)|sounds like you have|this is) (adhd|depression|anxiety disorder|a disorder|ptsd|bipolar|ocd)\b/i,
];

export function checkReplyTone(reply: string): ToneResult {
  const violations: ToneViolation[] = [];
  const r = reply ?? '';
  if (r.includes('—')) violations.push('em-dash');
  if (r.includes('!')) violations.push('exclamation');
  if (ABSENCE_COUNT_RES.some((re) => re.test(r))) violations.push('absence-count');
  if (COMMAND_RES.some((re) => re.test(r))) violations.push('command');
  if (DIAGNOSIS_RES.some((re) => re.test(r))) violations.push('diagnosis');
  return { ok: violations.length === 0, violations };
}

// ─── Turn parsing ───────────────────────────────────────────────────────────

export type CoachTurnFailureReason = 'invalid-json' | 'missing-reply' | 'tone';

export type CoachTurnResult =
  /** A reply with no plan on the table. */
  | { kind: 'reply'; reply: string }
  /** A reply plus a high-tier plan awaiting the person's tap. Nothing executed. */
  | { kind: 'plan'; reply: string; plan: CoachPendingPlan }
  /** A reply plus the details still needed before a plan can be executable. */
  | { kind: 'needs'; reply: string; needs: string[] }
  /** The turn cannot be shown. The screen shows a retry line, never silence. */
  | { kind: 'failed'; reason: CoachTurnFailureReason; violations?: ToneViolation[] };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseJson(raw: string): unknown | null {
  const cleaned = (raw ?? '').replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // JSON mode is a request, not a guarantee: a model can still wrap the
    // object in a sentence. Take the outermost object if there is one.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Human-readable "needs a detail" lines for actions the tier gate would not
 * execute. One per action, from the action's own missingFields where the
 * model supplied them, else a generic line naming the title.
 */
export function needsForActions(actions: ProposedAction[]): string[] {
  const lines: string[] = [];
  for (const a of actions) {
    const missing = Array.isArray(a.missingFields) ? a.missingFields.filter((f) => typeof f === 'string' && f.trim()) : [];
    if (missing.length) lines.push(`${a.title}: needs ${missing.join(', ')}`);
    else lines.push(`${a.title}: needs one more detail`);
  }
  return lines;
}

export function parseCoachTurn(
  raw: string,
  opts: { userText: string; now?: Date },
): CoachTurnResult {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) return { kind: 'failed', reason: 'invalid-json' };
  const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
  if (!reply) return { kind: 'failed', reason: 'missing-reply' };

  const tone = checkReplyTone(reply);
  if (!tone.ok) return { kind: 'failed', reason: 'tone', violations: tone.violations };

  const plan = parsed.plan;
  const rawActions = isRecord(plan) && Array.isArray(plan.actions) ? plan.actions : [];
  if (rawActions.length === 0) return { kind: 'reply', reply };

  const now = opts.now ?? new Date();
  const coerced = rawActions.map((a) => coerceAction(a, opts.userText));
  const resolution = resolveCaptureTier(coerced, opts.userText, now);

  const asPlan = (actions: ProposedAction[]): CoachTurnResult => ({
    kind: 'plan',
    reply,
    plan: {
      proposalKey: getProposalExecutionKey(actions),
      actions,
      hasCalendar: actions.some((a) => a.type === 'calendar_add'),
      createdAt: now.getTime(),
      applyingAt: null,
    },
  });

  if (resolution.tier === 'high' && resolution.actions.length > 0) return asPlan(resolution.actions);

  // The Command gate requires the DATE of a one-off to appear in the person's
  // own words before it may auto-write (a voice capture has no other confirm).
  // In the thread the coach picks the check-in date and nothing auto-writes:
  // the card shows every date and the person's tap is the confirm. So a
  // medium tier whose only question is "When?" is promoted to a plan when
  // each targeted one-off carries a valid, high-confidence dateStr of its own.
  // Any other medium (days of the week missing) or a low tier stays "needs".
  if (resolution.tier === 'medium' && resolution.clarification?.fieldKey === 'date') {
    const targets = resolution.clarification.targetIndices.map((i) => resolution.actions[i]);
    const datesSupplied =
      targets.length > 0 &&
      targets.every(
        (a) => !!a && a.type === 'todo_add' && !!a.dateStr && a.confidence === 'high' && validateProposedAction(a).valid,
      );
    if (datesSupplied) return asPlan(resolution.actions);
  }

  // Medium: the gate wants one detail (its clarification names the field).
  // Low: the gate returned no actions at all; read the model's own
  // missingFields off the coerced actions. Either way, nothing is executable
  // and the person is told exactly what is missing.
  const needs =
    resolution.tier === 'medium' && resolution.clarification
      ? [resolution.clarification.prompt]
      : needsForActions(coerced);
  return { kind: 'needs', reply, needs };
}

/** The retry line for a failed turn. Law C: accepts blame, never assigns it. */
export function failedTurnLine(reason: CoachTurnFailureReason | 'timeout' | 'offline'): string {
  switch (reason) {
    case 'tone':
      return 'That reply did not meet the bar. Try once more.';
    case 'timeout':
      return 'That took too long. Try once more.';
    case 'offline':
      return 'No connection right now. Try once more when you are back online.';
    default:
      return 'That did not come through. Try once more.';
  }
}

export type CoachTurnErrorKind =
  /** The auth session lookup wedged before any request left the phone. */
  | 'session-timeout'
  /** The network phase ran out of budget. */
  | 'timeout'
  | 'offline'
  /** The proxy answered with a non-2xx (status carried). */
  | 'ai_request_failed'
  /** A 200 with no usable content field. */
  | 'no-content'
  | 'error';

/**
 * Classify a thrown error from chatCompletion for the retry line and the
 * report. Every kind is reported (builds 255/256 hid the whole failure by
 * reporting only the non-timeout classes, and the class that was failing was
 * the one no report covered).
 */
export function classifyTurnError(err: unknown): { line: 'timeout' | 'offline' | 'invalid-json'; kind: CoachTurnErrorKind; status: number | null } {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (name === 'SessionTimeoutError') {
    return { line: 'timeout', kind: 'session-timeout', status: null };
  }
  if (name === 'AiTimeoutError' || /timed out|timeout/i.test(message)) {
    return { line: 'timeout', kind: 'timeout', status: null };
  }
  if (/Network request failed|network|offline/i.test(message)) {
    return { line: 'offline', kind: 'offline', status: null };
  }
  if (/AI returned no content/i.test(message)) {
    return { line: 'invalid-json', kind: 'no-content', status: null };
  }
  const m = message.match(/AI request failed \((\d{3})/);
  return { line: 'invalid-json', kind: m ? 'ai_request_failed' : 'error', status: m ? Number(m[1]) : null };
}

/**
 * The short code shown under the retry line, so a failure on a device can be
 * read back without a debugger. Names the app's step, never the person.
 */
export function failureCode(
  kind: CoachTurnErrorKind | CoachTurnFailureReason,
  extra?: { status?: number | null; violations?: ToneViolation[] },
): string {
  if (kind === 'ai_request_failed') return extra?.status ? `http ${extra.status}` : 'http';
  if (kind === 'tone' && extra?.violations?.length) return `tone: ${extra.violations.join(', ')}`;
  // "error" is the catch-all for a throw no class names; say so plainly.
  if (kind === 'error') return 'unknown';
  return kind;
}
