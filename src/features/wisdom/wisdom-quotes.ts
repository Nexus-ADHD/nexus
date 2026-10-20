// Pure quote helpers for Today's Wisdom (Orbit tab).
//
// Extracted from app/(tabs)/orbit.tsx so the no-repeat / fallback logic can be
// unit-tested in the pure-Node vitest suite (the RN screen and the zustand store
// can't be imported there). The orchestration that reads/writes the store lives
// in ./wisdom-service.ts; everything here is pure (no store, no network).

export type FallbackQuote = { quote: string; author: string; tag: string };

// Decide whether the generation loop in wisdom-service needs another pass after
// a completed one: the count is still on, AND either today's win changed
// mid-flight or the local day rolled over while the pass ran. Without the day
// check, a run crossing midnight exits with the prior day's quotes persisted
// (the '' === '' unchanged-win case) while callers believe today was handled.
export function shouldReRoll(opts: {
  countAfter: number;
  winAfter: string;
  intentionKey: string;
  dayAfter: string;
  todayKey: string;
}): boolean {
  if (opts.countAfter <= 0) return false;
  return opts.winAfter !== opts.intentionKey || opts.dayAfter !== opts.todayKey;
}

// Curated fallback library — used when AI generation fails or returns duplicates
// of recent history, and now ALSO rendered optimistically while the AI call is in
// flight so the section is never blank. Tags match the AI taxonomy so the
// tag-diverse picker mirrors the AI's variety contract.
export const FALLBACK_QUOTES: FallbackQuote[] = [
  // Leadership
  { quote: "Management is doing things right; leadership is doing the right things.", author: "Peter Drucker", tag: "Leadership" },
  { quote: "The supreme quality for leadership is unquestionably integrity.", author: "Dwight D. Eisenhower", tag: "Leadership" },
  { quote: "A leader is one who knows the way, goes the way, and shows the way.", author: "John C. Maxwell", tag: "Leadership" },
  { quote: "Lead from the back — and let others believe they are in front.", author: "Nelson Mandela", tag: "Leadership" },
  { quote: "The pessimist complains about the wind; the optimist expects it to change; the realist adjusts the sails.", author: "William Arthur Ward", tag: "Leadership" },
  { quote: "Earn your leadership every day.", author: "Michael Jordan", tag: "Leadership" },
  // Discipline
  { quote: "Discipline equals freedom.", author: "Jocko Willink", tag: "Discipline" },
  { quote: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", author: "Will Durant", tag: "Discipline" },
  { quote: "First we form habits, then they form us.", author: "Jim Rohn", tag: "Discipline" },
  { quote: "Suffer the pain of discipline or suffer the pain of regret.", author: "Jim Rohn", tag: "Discipline" },
  { quote: "You do not rise to the level of your goals. You fall to the level of your systems.", author: "James Clear", tag: "Discipline" },
  { quote: "What we plant in the soil of contemplation, we shall reap in the harvest of action.", author: "Meister Eckhart", tag: "Discipline" },
  // Resilience
  { quote: "The impediment to action advances action. What stands in the way becomes the way.", author: "Marcus Aurelius", tag: "Resilience" },
  { quote: "We suffer more often in imagination than in reality.", author: "Seneca", tag: "Resilience" },
  { quote: "He who has a why to live for can bear almost any how.", author: "Friedrich Nietzsche", tag: "Resilience" },
  { quote: "Fall seven times, stand up eight.", author: "Japanese Proverb", tag: "Resilience" },
  { quote: "Rock bottom became the solid foundation on which I rebuilt my life.", author: "J.K. Rowling", tag: "Resilience" },
  { quote: "Out of suffering have emerged the strongest souls.", author: "Khalil Gibran", tag: "Resilience" },
  // Peace
  { quote: "Peace is not the absence of conflict, but the ability to handle conflict by peaceful means.", author: "Ronald Reagan", tag: "Peace" },
  { quote: "Walk as if you are kissing the Earth with your feet.", author: "Thich Nhat Hanh", tag: "Peace" },
  { quote: "Wherever you go, there you are.", author: "Jon Kabat-Zinn", tag: "Peace" },
  { quote: "When you realize there is nothing lacking, the whole world belongs to you.", author: "Lao Tzu", tag: "Peace" },
  { quote: "A man who conquers himself is greater than one who conquers a thousand men in battle.", author: "Buddha", tag: "Peace" },
  { quote: "The truth you believe and cling to makes you unavailable to hear anything new.", author: "Pema Chödrön", tag: "Peace" },
  // Vision
  { quote: "The future belongs to those who believe in the beauty of their dreams.", author: "Eleanor Roosevelt", tag: "Vision" },
  { quote: "Vision without execution is hallucination.", author: "Thomas Edison", tag: "Vision" },
  { quote: "The best way to predict the future is to create it.", author: "Peter Drucker", tag: "Vision" },
  { quote: "Where there is no vision, the people perish.", author: "Proverbs 29:18", tag: "Vision" },
  { quote: "Stay hungry, stay foolish.", author: "Stewart Brand", tag: "Vision" },
  { quote: "The only way to do great work is to love what you do.", author: "Steve Jobs", tag: "Vision" },
  // Courage
  { quote: "Courage is not the absence of fear, but the triumph over it.", author: "Nelson Mandela", tag: "Courage" },
  { quote: "Do one thing every day that scares you.", author: "Eleanor Roosevelt", tag: "Courage" },
  { quote: "You will never do anything in this world without courage.", author: "Aristotle", tag: "Courage" },
  { quote: "Courage is grace under pressure.", author: "Ernest Hemingway", tag: "Courage" },
  { quote: "It takes courage to grow up and become who you really are.", author: "E.E. Cummings", tag: "Courage" },
  { quote: "The cave you fear to enter holds the treasure you seek.", author: "Joseph Campbell", tag: "Courage" },
  // Wisdom
  { quote: "Knowing yourself is the beginning of all wisdom.", author: "Aristotle", tag: "Wisdom" },
  { quote: "The only true wisdom is in knowing you know nothing.", author: "Socrates", tag: "Wisdom" },
  { quote: "Patience is the companion of wisdom.", author: "Augustine of Hippo", tag: "Wisdom" },
  { quote: "By three methods we may learn wisdom: by reflection, which is noblest; by imitation, which is easiest; and by experience, which is the bitterest.", author: "Confucius", tag: "Wisdom" },
  { quote: "He who knows others is wise; he who knows himself is enlightened.", author: "Lao Tzu", tag: "Wisdom" },
  { quote: "Until you make the unconscious conscious, it will direct your life and you will call it fate.", author: "Carl Jung", tag: "Wisdom" },
  // Service
  { quote: "The best way to find yourself is to lose yourself in the service of others.", author: "Mahatma Gandhi", tag: "Service" },
  { quote: "Life's most persistent and urgent question is, 'What are you doing for others?'", author: "Martin Luther King Jr.", tag: "Service" },
  { quote: "Not all of us can do great things. But we can do small things with great love.", author: "Mother Teresa", tag: "Service" },
  { quote: "Everybody can be great because anybody can serve.", author: "Martin Luther King Jr.", tag: "Service" },
  { quote: "We make a living by what we get. We make a life by what we give.", author: "Winston Churchill", tag: "Service" },
  { quote: "Service is the rent we pay for the privilege of living on this earth.", author: "Shirley Chisholm", tag: "Service" },
  // Creativity
  { quote: "Every child is an artist. The problem is how to remain an artist once we grow up.", author: "Pablo Picasso", tag: "Creativity" },
  { quote: "Creativity is intelligence having fun.", author: "Albert Einstein", tag: "Creativity" },
  { quote: "An essential aspect of creativity is not being afraid to fail.", author: "Edwin Land", tag: "Creativity" },
  { quote: "If you hear a voice within you say 'you cannot paint,' then by all means paint, and that voice will be silenced.", author: "Vincent van Gogh", tag: "Creativity" },
  { quote: "The chief enemy of creativity is good sense.", author: "Pablo Picasso", tag: "Creativity" },
  { quote: "You can't use up creativity. The more you use, the more you have.", author: "Maya Angelou", tag: "Creativity" },
  // Faith
  { quote: "Faith is taking the first step even when you don't see the whole staircase.", author: "Martin Luther King Jr.", tag: "Faith" },
  { quote: "All shall be well, and all shall be well, and all manner of thing shall be well.", author: "Julian of Norwich", tag: "Faith" },
  { quote: "The wound is the place where the light enters you.", author: "Rumi", tag: "Faith" },
  { quote: "Just trust yourself, then you will know how to live.", author: "Goethe", tag: "Faith" },
  { quote: "Faith is the strength by which a shattered world shall emerge into the light.", author: "Helen Keller", tag: "Faith" },
  { quote: "Be patient toward all that is unsolved in your heart.", author: "Rainer Maria Rilke", tag: "Faith" },
];

export const normalizeQuoteText = (s: string) =>
  String(s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

export const normalizeAuthor = (s: string) =>
  String(s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

// Drop any candidate whose quote-text OR author appears in the recent history.
// Author-level dedup is intentionally aggressive (per spec) — a Rumi yesterday
// means no Rumi today, even if it's a different quote.
export function filterAgainstHistory<T extends { quote: string; author: string }>(
  candidates: T[],
  history: Array<{ quote: string; author: string }>
): T[] {
  const bannedQuotes = new Set(history.map((h) => normalizeQuoteText(h.quote)));
  const bannedAuthors = new Set(history.map((h) => normalizeAuthor(h.author)));
  return candidates.filter(
    (c) =>
      !bannedQuotes.has(normalizeQuoteText(c.quote)) &&
      !bannedAuthors.has(normalizeAuthor(c.author))
  );
}

// ── Notification source (one quote, not three) ─────────────────────────────
// The daily morning/evening notifications carry ONE Today's-Wisdom line when it
// exists for the LOCAL day — the same quote set Orbit renders, generated from
// the user's today's win. These helpers decide what (if anything) the
// notification layer may use; the NEX-277 safety filter is applied separately
// in notification-quote-compose before any line reaches the lock screen.

/**
 * Today's wisdom quotes, only when they were generated for `todayKey` AND
 * wisdom is enabled (`wisdomQuoteCount !== 0` — count 0 means the user turned
 * Today's Wisdom off, so nothing may claim it as a source). Returns undefined
 * for a stale day / empty array / disabled wisdom: yesterday's quotes must
 * never fire as today's notification. `todayKey` comes from getLocalDateKey
 * (src/utils/recurrence.ts) — the caller derives it; this stays pure.
 */
export function todayWisdomForNotification(
  state: {
    dailyWisdomDate?: string;
    dailyWisdomQuotes?: { quote?: unknown; author?: unknown }[];
    wisdomQuoteCount?: number;
  },
  todayKey: string,
): { quote: string; author: string }[] | undefined {
  if (!state || state.wisdomQuoteCount === 0) return undefined;
  if (state.dailyWisdomDate !== todayKey) return undefined;
  if (!Array.isArray(state.dailyWisdomQuotes)) return undefined;
  const clean = state.dailyWisdomQuotes
    .map((q) => ({
      quote: typeof q?.quote === 'string' ? q.quote.trim() : '',
      author: typeof q?.author === 'string' ? q.author.trim() : '',
    }))
    .filter((q) => q.quote.length > 0);
  return clean.length > 0 ? clean : undefined;
}

/**
 * The wisdom quote for one notification slot (morning 0, evening 1). Slots get
 * DISTINCT quotes when ≥2 exist; with a single quote both slots share it —
 * there is nothing else to pick.
 */
export function wisdomQuoteForSlot(
  quotes: { quote: string; author: string }[],
  slot: 0 | 1,
): { quote: string; author: string } | undefined {
  if (!Array.isArray(quotes) || quotes.length === 0) return undefined;
  return quotes[slot % quotes.length];
}

/**
 * The wisdom set for ANY local date key: today's live set when `dateKey ===
 * todayKey`, otherwise the most recent generation for that day from
 * `recentWisdomHistory` (entries are appended per generation, so the LAST
 * `wisdomQuoteCount` entries for a day are its final set — earlier ones are
 * superseded same-day regenerations after the win changed). Used for the
 * morning nudge, which fires before today's win exists and so leads with
 * YESTERDAY's win. Disabled wisdom (count 0) → undefined, same as today.
 */
export function wisdomForNotificationDate(
  state: {
    dailyWisdomDate?: string;
    dailyWisdomQuotes?: { quote?: unknown; author?: unknown }[];
    wisdomQuoteCount?: number;
    recentWisdomHistory?: { quote?: unknown; author?: unknown; dateKey?: unknown }[];
  },
  dateKey: string,
  todayKey: string,
): { quote: string; author: string }[] | undefined {
  if (dateKey === todayKey) return todayWisdomForNotification(state, todayKey);
  if (!state || state.wisdomQuoteCount === 0) return undefined;
  if (!Array.isArray(state.recentWisdomHistory)) return undefined;
  const count = Math.max(1, Number(state.wisdomQuoteCount ?? 3));
  const forDay = state.recentWisdomHistory.filter((e) => e?.dateKey === dateKey);
  if (forDay.length === 0) return undefined;
  const clean = forDay
    .slice(-count)
    .map((q) => ({
      quote: typeof q?.quote === 'string' ? q.quote.trim() : '',
      author: typeof q?.author === 'string' ? q.author.trim() : '',
    }))
    .filter((q) => q.quote.length > 0);
  return clean.length > 0 ? clean : undefined;
}

// Pick `targetCount` fallback quotes, preferring tag diversity, after filtering
// out anything in the recent history. Pure: history is passed in, randomness is
// the only impurity (shuffle). Falls back to the full library if history would
// leave nothing.
export function pickFallbackQuotes(
  targetCount: number,
  history: Array<{ quote: string; author: string }>
): FallbackQuote[] {
  const filtered = filterAgainstHistory(FALLBACK_QUOTES, history);
  const pool = filtered.length > 0 ? filtered : FALLBACK_QUOTES; // last resort
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  // Pick from different tags when possible.
  const picked: FallbackQuote[] = [];
  const usedTags = new Set<string>();
  for (const q of shuffled) {
    if (picked.length >= targetCount) break;
    if (!usedTags.has(q.tag)) {
      picked.push(q);
      usedTags.add(q.tag);
    }
  }
  if (picked.length < targetCount) {
    for (const q of shuffled) {
      if (picked.length >= targetCount) break;
      if (!picked.includes(q)) picked.push(q);
    }
  }
  return picked;
}
