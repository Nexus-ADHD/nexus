// Inspire-screen data used by the onboarding flow in app/_layout.tsx.
// Kept here as a pure data module so it can be exercised from vitest
// without pulling in the React Native render path.

import tokens from '@/src/theme/tokens';

const GOLD = tokens.color.gold;

// The InspireScreen component in app/_layout.tsx renders by field
// presence (quote → quote layout, headline → headline layout, cta →
// cta layout), so the type is intentionally loose. The shared
// requirements are icon + accent, asserted in the tests.
export type InspireScreen = {
  accent: string;
  icon: string;
  cta?: true;
  quote?: string;
  headline?: string;
  body?: string;
  sub?: string;
  stats?: Array<{ label: string; value: string }>;
};

export const INSPIRE_SCREENS: InspireScreen[] = [
  {
    quote: '"The greatest victory is mastery over yourself."',
    sub: 'Are you ready to take control of your life?',
    accent: GOLD,
    icon: '◈',
  },
  {
    headline: 'THE THREAD YOU KEEP LOSING.',
    body: 'The person you mean to be gets buried under the noise. Nexus holds the thread: your mandates, your habits, and the next right thing.',
    accent: GOLD,
    icon: '◉',
  },
  {
    headline: 'A MISS ZEROES NOTHING.',
    body: 'Progress here is cumulative. Step away, come back, and what you built is still yours. No streak to break, no ground to make up.',
    accent: GOLD,
    icon: '◇',
  },
  {
    cta: true,
    headline: 'THIS IS WHERE\nYOU BEGIN.',
    sub: 'Become the you that already exists.',
    accent: GOLD,
    icon: '▲',
  },
];
