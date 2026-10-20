// NEX-210 (C-5) — AI service for "break this into steps". Thin wrapper over the
// proxy (mirrors pulse-recommendations.ts): one chatCompletion call, defensive
// parse, null-safe. Returns [] on any failure so the offer shows a no-blame
// retry rather than crashing or half-landing. Device-only to exercise
// (SIM_BYPASS → the proxy 401s on the simulator); the pure parse/gate is in
// breakdown.ts and fully unit-tested.
import { chatCompletion, type ChatMessage } from '../utils/ai-client';
// NEX-305: name the tier explicitly instead of riding the shared default.
import { MODELS } from '../utils/ai-models';
import {
  GRAIN,
  MAX_BREAKDOWN_STEPS,
  parseBreakdownSteps,
  type BreakdownGrain,
} from '../features/command/breakdown';

function stripFences(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function buildMessages(title: string, target: number): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You break a vague or large task into a short ordered list of concrete first-actionable steps for someone with ADHD who is frozen. ' +
        `Return ONLY JSON: {"steps":["..."]}. Give about ${target} steps. ` +
        'Each step: a concrete imperative under 8 words, the kind of action you could start in a minute, in the order you would do them. ' +
        'Do not number the steps, do not add preamble or commentary, do not restate the task. ' +
        'Do not atomize the obvious (no "pick up the phone"). No exclamation points, no em dashes, no emoji.',
    },
    { role: 'user', content: title },
  ];
}

/**
 * Break `title` into ~grain steps via the AI proxy. Returns a clean, capped step
 * list, or [] on any error/empty/parse failure (caller treats [] as "couldn't").
 */
export async function breakdownIntoSteps(
  title: string,
  grain: BreakdownGrain,
): Promise<string[]> {
  const clean = (title ?? '').trim();
  if (!clean) return [];
  const messages = buildMessages(clean, GRAIN[grain]);
  let raw: string;
  try {
    raw = await chatCompletion(messages, {
      model: MODELS.QUICK_PARSE,
      response_format: { type: 'json_object' },
    });
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return [];
  }
  return parseBreakdownSteps(parsed, MAX_BREAKDOWN_STEPS);
}
