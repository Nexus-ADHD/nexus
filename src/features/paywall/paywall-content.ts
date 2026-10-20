// src/features/paywall/paywall-content.ts
// NEX-119: remote paywall CONTENT (marketing copy only) sourced from the
// RevenueCat offering's `metadata` JSON, so copy can change without an App
// Store build — while the on-brand layout (the locked stellar aesthetic) stays
// in code. Pure module (no React Native / react-native-purchases imports) so it
// runs under the pure-Node vitest config and the paywall screen (which opts out
// of type-checking) consumes a typed, tested result.
//
// SCOPE (deliberate, per NEX-119 review):
//   Remote   → marketing copy: tagline, headline, feature bullets, plan
//              subtexts (annual/monthly), the "BEST VALUE" badge.
//   Hardcoded → action labels (CTA, restore, dismiss), the trial-note (it
//              states price + cancellation — legal), and the legal paragraph.
//              Those carry App-Review / legal weight and must not be authorable
//              from the dashboard.
//
// resolvePaywallContent() NEVER throws and falls back PER FIELD to the exact
// current strings, so an absent / partial / corrupt / wrong-typed metadata blob
// renders byte-for-byte today's paywall. Length caps are tuned to the fixed
// frame (a long string or an over-long feature list must not push the CTA below
// the fold), so the "layout stays fixed" guarantee holds.

// NEX-121: which paywall LAYOUT to render. Remote-selectable (offering metadata)
// so the "paywall as content" blurred-data variant can be A/B tested against the
// standard copy layout without a build. Anything not exactly 'data_preview'
// resolves to 'standard', so rollout is opt-in and safe.
export type PaywallVariant = 'standard' | 'data_preview';

export interface PaywallContent {
  /** NEX-121: layout variant. Default 'standard' (today's copy layout). */
  variant: PaywallVariant;
  tagline: string;
  /** May contain a single newline (2-line budget). */
  headline: string;
  features: string[];
  planSubtexts: { annual: string; monthly: string };
  bestValueBadge: string;
}

// DEFAULT = byte-for-byte the strings currently hardcoded in paywall-screen.tsx.
// Tests lock these so a drift is caught.
export const DEFAULT_PAYWALL_CONTENT: PaywallContent = {
  variant: 'standard',
  tagline: 'REMEMBER WHO YOU ARE',
  headline: 'Become the you\nthat already exists',
  features: [
    'AI Morning Brief & Daily Pulse',
    'Voice Command — speak to act',
    'Weekly, Monthly & Annual Reviews',
    'Unlimited habits & mandates',
    'Cloud backup & device sync',
    'Personalized daily wisdom',
  ],
  planSubtexts: { annual: 'Best value · Save 44%', monthly: 'Cancel anytime' },
  bestValueBadge: 'BEST VALUE',
};

// Caps tuned to the fixed frame. featureCount holds at today's 6 so a remote
// list can't push the plan cards / CTA below the fold on a small device.
const CAP = {
  tagline: 48,
  headline: 48,
  feature: 60,
  planSubtext: 40,
  badge: 24,
  featureCount: 6,
} as const;

// A valid override is a trimmed, non-empty string within the cap; anything else
// (wrong type, empty, over-long, or containing a line break) returns null so the
// caller uses the default. These are single-line fields — a stray newline would
// reflow the fixed frame, so reject it (the headline has its own resolver below).
function cleanString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0 || t.length > max || /[\r\n]/.test(t)) return null;
  return t;
}

// Headline is the ONE field allowed a line break (a 2-line budget). Dashboard
// text fields often can't store a real newline, so accept the literal 2-char
// sequence "\n" and normalize it. Reject more than 2 lines (one newline) — a
// 3-line headline would push the plan cards / CTA below the fold.
function resolveHeadline(v: unknown): string {
  if (typeof v !== 'string') return DEFAULT_PAYWALL_CONTENT.headline;
  const normalized = v.replace(/\\n/g, '\n').trim();
  const lineBreaks = (normalized.match(/\n/g) || []).length;
  if (normalized.length === 0 || normalized.length > CAP.headline || lineBreaks > 1) {
    return DEFAULT_PAYWALL_CONTENT.headline;
  }
  return normalized;
}

function resolveFeatures(v: unknown): string[] {
  if (!Array.isArray(v)) return DEFAULT_PAYWALL_CONTENT.features;
  const out: string[] = [];
  for (const item of v) {
    const s = cleanString(item, CAP.feature);
    if (s) out.push(s);
    if (out.length >= CAP.featureCount) break;
  }
  return out.length > 0 ? out : DEFAULT_PAYWALL_CONTENT.features;
}

function resolvePlanSubtexts(v: unknown): { annual: string; monthly: string } {
  const obj = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    annual: cleanString(obj.annual, CAP.planSubtext) ?? DEFAULT_PAYWALL_CONTENT.planSubtexts.annual,
    monthly: cleanString(obj.monthly, CAP.planSubtext) ?? DEFAULT_PAYWALL_CONTENT.planSubtexts.monthly,
  };
}

// NEX-121: only the exact literal 'data_preview' opts into the blurred-data
// layout; everything else (missing, wrong type, typo) → 'standard'. So a
// malformed metadata value can never strand a user on a broken variant.
function resolveVariant(v: unknown): PaywallVariant {
  return v === 'data_preview' ? 'data_preview' : 'standard';
}

/**
 * Resolve paywall marketing copy from a RevenueCat offering's `metadata`.
 * Pass `offering?.metadata` (or undefined). Never throws; every field falls
 * back to DEFAULT_PAYWALL_CONTENT independently.
 */
export function resolvePaywallContent(metadata: unknown): PaywallContent {
  const m = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
  return {
    variant: resolveVariant(m.variant),
    tagline: cleanString(m.tagline, CAP.tagline) ?? DEFAULT_PAYWALL_CONTENT.tagline,
    headline: resolveHeadline(m.headline),
    features: resolveFeatures(m.features),
    planSubtexts: resolvePlanSubtexts(m.planSubtexts),
    bestValueBadge: cleanString(m.bestValueBadge, CAP.badge) ?? DEFAULT_PAYWALL_CONTENT.bestValueBadge,
  };
}
