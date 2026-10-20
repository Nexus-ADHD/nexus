// Today's Wisdom generation — store-aware orchestration (Orbit tab).
//
// Extracted from app/(tabs)/orbit.tsx so it is callable from BOTH the Orbit
// screen and Home: when today's win changes on Home, we pre-warm generation
// fire-and-forget so the quotes are ready (or already in flight) by the time the
// user reaches Orbit, instead of paying full AI latency on Orbit focus.
//
// A module-level single-flight promise dedupes concurrent callers (Home pre-warm
// + Orbit focus can't double-generate) — it replaces the old component-scoped
// `quotesGeneratingRef`. Pure quote helpers (fallback library, dedup) live in
// ./wisdom-quotes.ts and are unit-tested; this module reads/writes the store.

import { useAppState } from '../../state/app-state';
import { syncWidgetAfterMutation } from '../../widgets/widget-bridge';
import { buildAIContext } from '../../utils/ai-context';
import { chatCompletion } from '../../utils/ai-client';
// NEX-305: name the tier explicitly instead of riding the shared default.
import { MODELS } from '../../utils/ai-models';
import {
  FallbackQuote,
  filterAgainstHistory,
  normalizeQuoteText,
  pickFallbackQuotes,
  shouldReRoll,
} from './wisdom-quotes';

type Quote = { quote: string; author: string; tag?: string };

// Bound each wisdom AI call so a slow/hung proxy can't keep the section spinning
// (the optimistic fallback already on screen stays, and the library tops up).
const WISDOM_AI_TIMEOUT_MS = 9000;

function todayKeyOf(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Today's win text, but only if it was set today (else ''). Same derivation the
// staleness predicate and the old inline generator used.
function currentWinFor(todayKey: string): string {
  const s = useAppState.getState() as any;
  return s.morningIntentionDate === todayKey ? (s.morningIntention || '').trim() : '';
}

function currentCount(): number {
  return Math.max(0, Number((useAppState.getState() as any).wisdomQuoteCount ?? 3));
}

export function getRecentHistoryWindow(days: number): Array<{ quote: string; author: string; dateKey: string }> {
  const liveState = useAppState.getState() as any;
  const all = Array.isArray(liveState.recentWisdomHistory) ? liveState.recentWisdomHistory : [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  return all.filter((e: any) => typeof e?.dateKey === 'string' && e.dateKey >= cutoffKey);
}

// Instant, synchronous local pick (no network). Reads the recent history from the
// store but writes nothing. Used both as the AI top-up and as the optimistic
// render in Orbit while the AI call is in flight.
export function getFallbackQuotes(targetCount: number): FallbackQuote[] {
  return pickFallbackQuotes(targetCount, getRecentHistoryWindow(14));
}

// One full generation pass for a given (day, win, count): up to two AI rounds,
// fallback top-up, then persist. Mirrors the original generateQuotes try/catch.
async function runPass(todayKey: string, intentionKey: string, targetCount: number): Promise<void> {
  try {
    const ctx = buildAIContext();
    const contextSummary = ctx.contextString || 'Live with intention and build something meaningful.';

    const history14 = getRecentHistoryWindow(14);
    const banlistLines = history14
      .map((h) => {
        const truncated = h.quote.length > 60 ? `${h.quote.slice(0, 57)}…` : h.quote;
        return `- "${truncated}" — ${h.author}`;
      })
      .join('\n');

    const callAI = async (extraInstruction: string): Promise<Quote[]> => {
      const systemContent = `Return ONLY valid JSON. No markdown. No explanation. Format:
{"quotes":[{"quote":"...","author":"...","tag":"Leadership|Discipline|Resilience|Peace|Vision|Courage|Wisdom|Service|Creativity|Faith"}]}
Rules: return exactly ${targetCount} quotes. Prefer different traditions (stoic, spiritual, business, athletic, philosophical, literary). Concise. No cliché. Each must feel connected to the user's context.${
        banlistLines
          ? `\n\nBANNED — do NOT return any quote or author from this list:\n${banlistLines}${extraInstruction ? `\n\n${extraInstruction}` : ''}`
          : extraInstruction ? `\n\n${extraInstruction}` : ''
      }`;
      const raw = await chatCompletion(
        [
          { role: 'system', content: systemContent },
          {
            role: 'user',
            content: `User context: ${contextSummary}

Pick ${targetCount} quotes that feel relevant to this person's current focus. Avoid: "be the change", "journey of 1000 miles", "shoot for the moon".`,
          },
        ],
        { model: MODELS.DAILY_PULSE, timeoutMs: WISDOM_AI_TIMEOUT_MS }
      );
      const cleaned = raw.replace(/```[a-z]*/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed.quotes)) throw new Error('Invalid quote format');
      return parsed.quotes
        .filter((q: any) => q && typeof q.quote === 'string' && typeof q.author === 'string')
        .map((q: any) => ({ quote: q.quote, author: q.author, tag: typeof q.tag === 'string' ? q.tag : '' }));
    };

    // Single AI round (bounded by WISDOM_AI_TIMEOUT_MS). The old second "STRICT"
    // retry doubled worst-case latency for marginal banlist gains; the curated
    // library top-up below covers any shortfall instantly.
    let candidates: Quote[] = [];
    try {
      candidates = await callAI('');
    } catch {
      candidates = [];
    }
    const unique = filterAgainstHistory(candidates, history14);

    // Top up from the fallback library (already filtered against history)
    if (unique.length < targetCount) {
      const fb = getFallbackQuotes(targetCount);
      const seen = new Set(unique.map((q) => normalizeQuoteText(q.quote)));
      for (const q of fb) {
        if (unique.length >= targetCount) break;
        const k = normalizeQuoteText(q.quote);
        if (!seen.has(k)) {
          unique.push(q);
          seen.add(k);
        }
      }
    }

    const finalQuotes = unique.slice(0, targetCount);
    const live = useAppState.getState() as any;
    if (finalQuotes.length === targetCount) {
      live.setDailyWisdom(finalQuotes, todayKey, intentionKey);
      live.appendWisdomHistory(finalQuotes, todayKey);
      syncWidgetAfterMutation(); // widget quote of the day
    } else if (live.dailyWisdomDate !== todayKey) {
      // True last resort — couldn't even build the target from the fallback library.
      const last = getFallbackQuotes(targetCount);
      live.setDailyWisdom(last, todayKey, intentionKey);
      syncWidgetAfterMutation();
    }
  } catch {
    const live = useAppState.getState() as any;
    if (live.dailyWisdomDate !== todayKey) {
      const fb = getFallbackQuotes(targetCount);
      live.setDailyWisdom(fb, todayKey, intentionKey);
      live.appendWisdomHistory(fb, todayKey);
      syncWidgetAfterMutation();
    }
  }
}

async function runGeneration(): Promise<void> {
  // Re-roll if today's win changed mid-flight (matches the old finally-block
  // self-converging behavior) OR the local day rolled over while the pass ran —
  // a run crossing midnight (or joined via single-flight for the new day) would
  // otherwise exit with yesterday's quotes persisted while callers believe
  // today was handled (the '' === '' unchanged-win case). Bounded so a
  // rapidly-edited win can't spin.
  const MAX_PASSES = 3;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const todayKey = todayKeyOf();
    const targetCount = currentCount();
    const intentionKey = currentWinFor(todayKey);
    if (targetCount === 0) {
      useAppState.getState().setDailyWisdom([], todayKey, intentionKey);
      syncWidgetAfterMutation(); // clear the widget quote too
      return;
    }
    await runPass(todayKey, intentionKey, targetCount);
    const dayAfter = todayKeyOf();
    if (!shouldReRoll({
      countAfter: currentCount(),
      winAfter: currentWinFor(dayAfter),
      intentionKey,
      dayAfter,
      todayKey,
    })) return;
  }
}

let inFlight: Promise<void> | null = null;

// Generate Today's Wisdom against the live store. Concurrent callers share one
// in-flight run (single-flight) so Home's pre-warm and Orbit's focus trigger
// can't double-generate. Fire-and-forget safe: the returned promise NEVER
// rejects — runPass already swallows AI/parse errors, and the outer `.catch`
// guards against any unexpected store-setter throw so `void generateWisdom()`
// can't become an unhandled rejection.
export function generateWisdom(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runGeneration()
    .catch(() => {
      /* never rejects — fallback already written by runPass on the failure paths */
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
